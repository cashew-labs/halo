import {
  decodeHtmlEntities,
  Extension,
  getMarkRange,
  type Editor,
  type Range,
} from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { marked, type Token } from "marked";
import { serializeMarkdown } from "./serializeMarkdown.js";

/** An editing view over one rich-text fragment; syntax never becomes a document node. */
type ActiveSyntax = {
  id: number;
  from: number;
  to: number;
  block: boolean;
  source: string;
};
const syntaxKey = new PluginKey<ActiveSyntax | undefined>("markdownSyntax");

export const MarkdownSyntax = Extension.create({
  name: "markdownSyntax",
  addProseMirrorPlugins() {
    const editor = this.editor;
    let controller: SyntaxController | undefined;
    return [
      new Plugin<ActiveSyntax | undefined>({
        key: syntaxKey,
        state: {
          init: () => undefined,
          apply(tr, active) {
            // SAFETY: only this plugin writes this private key, always with an active field.
            const change = tr.getMeta(syntaxKey) as
              | { active: ActiveSyntax | undefined }
              | undefined;
            if (change !== undefined) return change.active;
            if (active === undefined || !tr.docChanged) return active;
            const from = tr.mapping.map(active.from, -1);
            const to = tr.mapping.map(active.to, 1);
            if (from < 1 || to > tr.doc.content.size) return undefined;
            if (!tr.doc.resolve(from).sameParent(tr.doc.resolve(to)))
              return undefined;
            return {
              ...active,
              from,
              to,
              source: fragmentSource(editor, tr.doc, from, to, active.block),
            };
          },
        },
        props: {
          decorations(state) {
            const active = syntaxKey.getState(state);
            if (active === undefined || controller === undefined)
              return DecorationSet.empty;
            return DecorationSet.create(state.doc, [
              ...(active.from === active.to
                ? []
                : [
                    Decoration.inline(active.from, active.to, {
                      style: "display: none",
                    }),
                  ]),
              Decoration.widget(active.from, () => controller!.createSource(), {
                key: String(active.id),
                side: -1,
                marks: [],
                stopEvent: () => true,
                ignoreSelection: true,
              }),
            ]);
          },
        },
        view(view) {
          controller = new SyntaxController({ view, editor });
          return controller;
        },
      }),
    ];
  },
});

function fragmentSource(
  editor: Editor,
  doc: ProseMirrorNode,
  from: number,
  to: number,
  block: boolean,
) {
  const parent = doc.resolve(from).parent;
  return serializeMarkdown({
    editor,
    content: {
      type: "doc",
      content: [
        {
          type: block ? parent.type.name : "paragraph",
          attrs: block ? parent.attrs : undefined,
          content: doc.slice(from, to).content.toJSON(),
        },
      ],
    },
  });
}

class SyntaxController {
  // The view owns focus, pointer settling, and the temporary source DOM.
  private source: HTMLSpanElement | undefined;
  private renderedSource: string | undefined;
  private frame: number | undefined;
  private pointerId: number | undefined;
  private pointerTarget: Element | undefined;
  private composing = false;
  private nextId = 0;
  private suppressedPosition: number | undefined;
  private readonly document: Document;
  private readonly window: Window;

  private readonly view: EditorView;
  private readonly editor: Editor;

  constructor(ctx: { view: EditorView; editor: Editor }) {
    const { view, editor } = ctx;
    this.view = view;
    this.editor = editor;
    this.document = view.dom.ownerDocument;
    this.window = this.document.defaultView!;
    this.document.addEventListener("pointerdown", this.pointerDown, true);
    this.document.addEventListener("pointerup", this.pointerUp);
    this.document.addEventListener("pointercancel", this.pointerUp);
    this.document.addEventListener("focusin", this.schedule);
    this.document.addEventListener("focusout", this.schedule);
    this.window.addEventListener("blur", this.cancelPointer);
  }

  update() {
    const active = syntaxKey.getState(this.view.state);
    if (active !== undefined && this.source !== undefined && !this.composing) {
      this.render(active.source);
    }
    this.schedule();
  }

  destroy() {
    this.document.removeEventListener("pointerdown", this.pointerDown, true);
    this.document.removeEventListener("pointerup", this.pointerUp);
    this.document.removeEventListener("pointercancel", this.pointerUp);
    this.document.removeEventListener("focusin", this.schedule);
    this.document.removeEventListener("focusout", this.schedule);
    this.window.removeEventListener("blur", this.cancelPointer);
    if (this.frame !== undefined) this.window.cancelAnimationFrame(this.frame);
  }

  private pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return;
    this.pointerId = event.pointerId;
    this.pointerTarget =
      event.target instanceof Element && this.view.dom.contains(event.target)
        ? event.target
        : undefined;
    if (
      event.target instanceof Node &&
      this.source !== undefined &&
      this.view.dom.contains(event.target) &&
      !this.source.contains(event.target)
    ) {
      // Nested contenteditables otherwise retain focus when clicking their outer editor.
      // Focus the outer editor before its normal mouse handler places the selection.
      this.source.blur();
      this.view.dom.focus();
    }
  };
  private pointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    this.pointerId = undefined;
    this.schedule();
  };
  private cancelPointer = () => {
    this.pointerId = undefined;
    this.schedule();
  };
  private schedule = () => {
    if (this.frame !== undefined) return;
    this.frame = this.window.requestAnimationFrame(() => {
      this.frame = undefined;
      if (this.pointerId === undefined && !this.composing) {
        this.reconcile();
        this.pointerTarget = undefined;
      }
    });
  };

  private reconcile() {
    if (
      this.view.editable &&
      this.source?.contains(this.document.activeElement)
    )
      return;
    // Chromium may deliver selectionchange after this animation frame. Read the
    // settled native selection before changing decorations, which can move its DOM.
    const selection = this.document.getSelection();
    if (
      this.view.hasFocus() &&
      selection?.anchorNode &&
      selection.focusNode &&
      this.view.dom.contains(selection.anchorNode) &&
      this.view.dom.contains(selection.focusNode) &&
      !this.source?.contains(selection.anchorNode) &&
      !this.source?.contains(selection.focusNode) &&
      this.view.state.selection instanceof TextSelection
    ) {
      const anchor = this.view.posAtDOM(
        selection.anchorNode,
        selection.anchorOffset,
      );
      const head = this.view.posAtDOM(
        selection.focusNode,
        selection.focusOffset,
      );
      if (
        anchor !== this.view.state.selection.anchor ||
        head !== this.view.state.selection.head
      ) {
        this.view.dispatch(
          this.view.state.tr.setSelection(
            TextSelection.between(
              this.view.state.doc.resolve(anchor),
              this.view.state.doc.resolve(head),
            ),
          ),
        );
      }
    }
    const { state } = this.view;
    const active = syntaxKey.getState(state);
    if (active !== undefined) {
      this.view.dispatch(state.tr.setMeta(syntaxKey, { active: undefined }));
      this.source = undefined;
      this.renderedSource = undefined;
    }
    if (
      !this.view.hasFocus() ||
      !this.view.editable ||
      !this.view.state.selection.empty
    )
      return;
    const { $from, from } = this.view.state.selection;
    if (from === this.suppressedPosition) return;
    this.suppressedPosition = undefined;
    const selectors = new Map([
      ["bold", "strong, b"],
      ["italic", "em, i"],
      ["strike", "s, del"],
      ["code", "code"],
      ["link", "a"],
    ]);
    const ranges = [
      ...$from.marks(),
      ...($from.nodeAfter?.marks ?? []),
    ].flatMap((mark) => {
      const selector = selectors.get(mark.type.name);
      if (selector === undefined) return [];
      const range = getMarkRange($from, mark.type, mark.attrs);
      if (range === undefined) return [];
      const inside = from > range.from && from < range.to;
      // A click on a one-character mark can only land at an endpoint. The
      // clicked element distinguishes that from typing beside formatted text.
      const clicked = this.pointerTarget?.closest(selector);
      return inside ||
        (clicked !== undefined &&
          clicked !== null &&
          this.view.dom.contains(clicked) &&
          from >= range.from &&
          from <= range.to)
        ? [range]
        : [];
    });
    const range = ranges.reduce<Range | undefined>(
      (widest, current) =>
        widest === undefined ||
        current.to - current.from > widest.to - widest.from
          ? current
          : widest,
      undefined,
    );
    const block = range === undefined && $from.parent.type.name === "heading";
    if (range === undefined && !block) return;
    const start = range?.from ?? $from.start();
    const end = range?.to ?? $from.end();
    // Images and other inline atoms keep their existing rich editing UI.
    let textOnly = true;
    this.view.state.doc.nodesBetween(start, end, (node) => {
      if (node.isInline && !node.isText) textOnly = false;
    });
    if (!textOnly) return;
    const source = fragmentSource(
      this.editor,
      this.view.state.doc,
      start,
      end,
      block,
    );
    const next: ActiveSyntax = {
      id: ++this.nextId,
      from: start,
      to: end,
      block,
      source,
    };
    this.view.dispatch(this.view.state.tr.setMeta(syntaxKey, { active: next }));
    const layout = sourceLayout(source, block);
    this.source?.focus();
    this.selectSource(layout.positions[from - start] ?? source.length);
  }

  createSource() {
    const wrapper = this.document.createElement("span");
    wrapper.className = "markdown-source-wrapper";
    const source = this.document.createElement("span");
    source.className = "markdown-source";
    source.contentEditable = "plaintext-only";
    source.tabIndex = -1;
    source.setAttribute("role", "textbox");
    source.setAttribute("aria-label", "Markdown syntax");
    source.spellcheck = true;
    wrapper.append(source);
    this.source = source;
    this.renderedSource = undefined;
    source.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    source.addEventListener("compositionend", () => {
      this.composing = false;
      this.input();
    });
    source.addEventListener("input", () => {
      if (!this.composing) this.input();
    });
    source.addEventListener("keydown", this.keyDown);
    source.addEventListener("paste", this.paste);
    source.addEventListener("click", (event) => {
      // The host handles modified link clicks in capture phase; ordinary clicks edit.
      if (event.target instanceof Element && event.target.closest("a"))
        event.preventDefault();
    });
    this.render(syntaxKey.getState(this.view.state)!.source);
    return wrapper;
  }

  private render(value: string) {
    if (this.source === undefined || this.renderedSource === value) return;
    const selection = this.sourceSelection();
    const layout = sourceLayout(
      value,
      syntaxKey.getState(this.view.state)?.block ?? false,
    );
    const children = layout.segments.map((segment) => {
      const span = this.document.createElement(
        segment.href === undefined ? "span" : "a",
      );
      if (segment.href !== undefined) span.setAttribute("href", segment.href);
      span.className = segment.classes.join(" ");
      span.textContent = value.slice(segment.from, segment.to);
      return span;
    });
    this.source.replaceChildren(...children);
    this.renderedSource = value;
    if (selection !== undefined)
      this.selectSource(selection.anchor, selection.head);
  }

  private sourceSelection() {
    const selection = this.document.getSelection();
    const source = this.source;
    if (
      source === undefined ||
      selection === null ||
      !source.contains(selection.anchorNode) ||
      !source.contains(selection.focusNode)
    )
      return undefined;
    const offset = (node: Node, end: number) => {
      const range = this.document.createRange();
      range.selectNodeContents(source);
      range.setEnd(node, end);
      return range.toString().length;
    };
    return {
      anchor: offset(selection.anchorNode!, selection.anchorOffset),
      head: offset(selection.focusNode!, selection.focusOffset),
    };
  }

  private selectSource(anchor: number, head = anchor) {
    const source = this.source;
    if (source === undefined) return;
    const point = (offset: number): [Node, number] => {
      const walker = this.document.createTreeWalker(
        source,
        NodeFilter.SHOW_TEXT,
      );
      let remaining = offset;
      let node = walker.nextNode();
      while (node !== null) {
        if (remaining <= node.textContent!.length) return [node, remaining];
        remaining -= node.textContent!.length;
        node = walker.nextNode();
      }
      return [source, source.childNodes.length];
    };
    this.document
      .getSelection()
      ?.setBaseAndExtent(...point(anchor), ...point(head));
  }

  private input() {
    const active = syntaxKey.getState(this.view.state);
    if (active === undefined || this.source === undefined) return;
    const selection = this.sourceSelection();
    const source = this.source.textContent ?? "";
    // The public Markdown parser parses blocks. A neutral paragraph prefix keeps
    // inline edits such as "# **title**" from becoming a heading and losing "# ".
    const prefix = active.block ? "" : "x ";
    const parsed = this.editor.schema.nodeFromJSON(
      this.editor.markdown!.parse(prefix + source),
    );
    const first = parsed.firstChild;
    const textblock =
      parsed.childCount === 1 && first?.isTextblock ? first : undefined;
    const content =
      textblock !== undefined
        ? textblock.content.cut(prefix.length)
        : Fragment.from(this.editor.schema.text(source || " "));
    const tr = this.view.state.tr.replaceWith(
      active.from,
      active.to,
      source === "" ? Fragment.empty : content,
    );
    if (active.block) {
      tr.setNodeMarkup(
        active.from - 1,
        textblock?.type ?? this.editor.schema.nodes.paragraph,
        textblock?.attrs,
      );
    }
    const next = {
      ...active,
      to: active.from + (source === "" ? 0 : content.size),
      source,
    };
    tr.setMeta(syntaxKey, { active: next });
    // Updating a preview without changing its semantic content must not trigger autosave/history.
    if (tr.doc.eq(this.view.state.doc))
      tr.setMeta("addToHistory", false).setMeta("preventUpdate", true);
    this.view.dispatch(tr);
    this.render(source);
    this.source?.focus();
    if (selection !== undefined)
      this.selectSource(selection.anchor, selection.head);
  }

  private exitSource() {
    const active = syntaxKey.getState(this.view.state);
    if (active === undefined) return;
    const selection = this.sourceSelection();
    const positions = sourceLayout(active.source, active.block).positions;
    const toPosition = (offset: number) =>
      Math.min(
        active.to,
        active.from + positions.filter((pos) => pos < offset).length,
      );
    const anchor =
      selection === undefined ? active.from : toPosition(selection.anchor);
    const head =
      selection === undefined ? active.from : toPosition(selection.head);
    this.suppressedPosition = head;
    const tr = this.view.state.tr.setMeta(syntaxKey, { active: undefined });
    tr.setSelection(TextSelection.create(tr.doc, anchor, head));
    this.view.dispatch(tr);
    this.source = undefined;
    this.renderedSource = undefined;
    this.view.focus();
  }

  private keyDown = (event: KeyboardEvent) => {
    // IME candidate navigation and confirmation belong to the composing editor.
    if (this.composing || event.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) this.editor.commands.redo();
      else this.editor.commands.undo();
      return;
    }
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.exitSource();
      this.editor.commands.selectAll();
      return;
    }
    const selection = this.sourceSelection();
    const boundary =
      selection !== undefined &&
      selection.anchor === selection.head &&
      ((["ArrowLeft", "Backspace"].includes(event.key) &&
        selection.head === 0) ||
        (["ArrowRight", "Delete"].includes(event.key) &&
          selection.head === this.source?.textContent?.length));
    if (
      event.key === "Escape" ||
      event.key === "Enter" ||
      event.key === "Tab" ||
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      boundary ||
      (mod && ["b", "i", "\\"].includes(event.key.toLowerCase()))
    ) {
      this.exitSource();
      if (
        event.key === "Escape" ||
        this.view.someProp("handleKeyDown", (handler) =>
          handler(this.view, event),
        )
      ) {
        event.preventDefault();
      }
      // Leave unhandled movement/deletion to the browser at the restored rich caret.
    }
  };

  private paste = (event: ClipboardEvent) => {
    if (event.clipboardData === null) return;
    const data = event.clipboardData;
    if (
      data.files.length === 0 &&
      !data.getData("text/html") &&
      !/[\r\n]/.test(data.getData("text/plain"))
    )
      return;
    event.preventDefault();
    this.exitSource();
    // Reuse Tiptap's normal rich-HTML and image paste handlers at the mapped selection.
    this.view.dom.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  };
}

type SourceRange = {
  from: number;
  to: number;
  classes: string[];
  marker?: boolean;
  href?: string;
};
function sourceLayout(source: string, block: boolean) {
  const ranges: SourceRange[] = [];
  const entityContinuation = new Set<number>();
  const visit = (tokens: Token[] | undefined, start: number) => {
    if (tokens === undefined) return;
    let from = start;
    for (const token of tokens) {
      const to = from + token.raw.length;
      const classes =
        token.type === "strong"
          ? ["markdown-source-bold"]
          : token.type === "em"
            ? ["markdown-source-italic"]
            : token.type === "del"
              ? ["markdown-source-strike"]
              : token.type === "codespan"
                ? ["markdown-source-code"]
                : [];
      const marker = (a: number, b: number) => {
        if (b > a)
          ranges.push({
            from: a,
            to: b,
            classes: ["markdown-marker"],
            marker: true,
          });
      };
      if (
        token.type === "strong" ||
        token.type === "em" ||
        token.type === "del"
      ) {
        const size = token.type === "em" ? 1 : 2;
        marker(from, from + size);
        marker(to - size, to);
        ranges.push({ from: from + size, to: to - size, classes });
        visit(token.tokens, from + size);
      } else if (token.type === "codespan") {
        const size = /^`+/.exec(token.raw)![0].length;
        const inner = token.raw.slice(size, -size);
        const padding =
          inner.startsWith(" ") && inner.endsWith(" ") && /[^ ]/.test(inner)
            ? 1
            : 0;
        marker(from, from + size + padding);
        marker(to - size - padding, to);
        ranges.push({
          from: from + size + padding,
          to: to - size - padding,
          classes,
        });
      } else if (token.type === "link") {
        const size = token.raw.indexOf("[") + 1;
        const end = from + size + token.text.length;
        marker(from, from + size);
        marker(end, to);
        ranges.push({
          from: from + size,
          to: end,
          classes: [],
          href: token.href,
        });
        visit(token.tokens, from + size);
      } else if (token.type === "escape") {
        marker(from, from + 1);
      } else if (token.type === "heading") {
        const size = /^#{1,6}\s+/.exec(token.raw)?.[0].length ?? 0;
        marker(from, from + size);
        visit(token.tokens, from + size);
      } else if (token.type === "paragraph") {
        visit(token.tokens, from);
      } else if (token.type === "text") {
        // Match Tiptap's entity decoder, including its single-pass semantics.
        for (const match of token.raw.matchAll(/&[a-z]+;/g)) {
          if (decodeHtmlEntities(match[0]) === match[0]) continue;
          for (let offset = 1; offset < match[0].length; offset++) {
            entityContinuation.add(from + match.index + offset);
          }
        }
      }
      from = to;
    }
  };
  visit(block ? marked.lexer(source) : marked.Lexer.lexInline(source), 0);
  const positions = Array.from({ length: source.length }, (_, i) => i).filter(
    (i) =>
      !entityContinuation.has(i) &&
      !ranges.some((range) => range.marker && i >= range.from && i < range.to),
  );
  const breaks = [
    ...new Set([
      0,
      source.length,
      ...ranges.flatMap((range) => [range.from, range.to]),
    ]),
  ];
  breaks.sort((a, b) => a - b);
  const segments = breaks.slice(0, -1).map((from, i) => ({
    from,
    to: breaks[i + 1]!,
    href: ranges.find(
      (range) =>
        range.href !== undefined && range.from <= from && range.to > from,
    )?.href,
    classes: ranges
      .filter((range) => range.from <= from && range.to > from)
      .flatMap((range) => range.classes),
  }));
  return { positions, segments };
}
