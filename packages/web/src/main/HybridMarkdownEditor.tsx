import { useEffect, useRef, useState } from "react";
import {
  Compartment,
  EditorState,
  StateEffect,
  Transaction,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  placeholder as editorPlaceholder,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentMore,
  indentLess,
} from "@codemirror/commands";
import { syntaxTree, indentUnit } from "@codemirror/language";
import { marked } from "marked";
import {
  MarkdownImageWidget,
  type MarkdownResources,
} from "./MarkdownImageWidget.js";
import { markdownImagePaste } from "./markdownImagePaste.js";
import { markdown } from "@codemirror/lang-markdown";
import {
  colors,
  fontFamily,
  monoFontFamily,
  proseHtml,
  type ProseSize,
} from "maui";
import { style, useStyles } from "purse-styles";
import { useRefCurrent } from "./agent/useRefCurrent.js";

export function HybridMarkdownEditor(props: {
  content: string;
  onChange(markdown: string): void;
  "aria-label": string;
  placeholder?: string;
  autoFocus?: boolean;
  editable?: boolean;
  onSubmit?: () => void;
  size?: ProseSize;
  resources?: MarkdownResources;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const current = useRefCurrent(props);
  const ariaLabel = props["aria-label"];
  const [configuration] = useState(() => new Compartment());
  const className = useStyles(proseHtml(props.size ?? "md"), editorStyle);
  useEffect(() => {
    if (host.current === null) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: current.current.content,
        extensions: [
          markdown(),
          history(),
          EditorView.domEventHandlers({
            click(event) {
              if (
                event.target instanceof Element &&
                event.target.closest("a") !== null &&
                !event.metaKey &&
                !event.ctrlKey
              )
                event.preventDefault();
              return false;
            },
          }),
          EditorView.lineWrapping,
          configuration.of([
            EditorView.contentAttributes.of({
              "aria-label": current.current["aria-label"],
              spellcheck: "true",
            }),
            EditorView.editable.of(current.current.editable !== false),
            editorPlaceholder(current.current.placeholder ?? "Write…"),
          ]),
          indentUnit.of("  "),
          hybridPreview(current.current.resources),
          current.current.resources === undefined
            ? []
            : markdownImagePaste(current.current.resources),
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                current.current.onSubmit?.();
                return true;
              },
            },
            {
              key: "Mod-b",
              run: (target) => toggleInline(target, "StrongEmphasis", "**"),
            },
            {
              key: "Mod-i",
              run: (target) => toggleInline(target, "Emphasis", "*"),
            },
            { key: "Tab", run: indentMore },
            { key: "Shift-Tab", run: indentLess },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              current.current.onChange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = editor;
    if (current.current.autoFocus) editor.focus();
    return () => {
      editor.destroy();
      view.current = undefined;
    };
  }, [current, configuration]);

  useEffect(() => {
    view.current?.dispatch({
      effects: configuration.reconfigure([
        EditorView.contentAttributes.of({
          "aria-label": ariaLabel,
          spellcheck: "true",
        }),
        EditorView.editable.of(props.editable !== false),
        editorPlaceholder(props.placeholder ?? "Write…"),
      ]),
    });
  }, [configuration, ariaLabel, props.editable, props.placeholder]);

  useEffect(() => {
    const editor = view.current;
    if (editor === undefined || editor.state.doc.toString() === props.content)
      return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: props.content },
      annotations: Transaction.addToHistory.of(false),
    });
  }, [props.content]);

  return (
    <div
      ref={host}
      className={className}
      onClick={(event) => {
        const editor = view.current;
        if (
          editor === undefined ||
          (event.target instanceof Node &&
            editor.contentDOM.contains(event.target))
        )
          return;
        editor.focus();
        editor.dispatch({ selection: { anchor: editor.state.doc.length } });
      }}
    />
  );
}

const settlePointer = StateEffect.define<void>();

const hybridPreview = (resources: MarkdownResources | undefined) =>
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      // Freeze layout throughout a pointer gesture, including its final selection update.
      private pointerId: number | undefined;
      private revealFrame: number | undefined;
      private readonly view: EditorView;
      private readonly window: Window;

      constructor(view: EditorView) {
        this.view = view;
        this.window = view.dom.ownerDocument.defaultView!;
        this.decorations = decorate(view, resources);
        view.dom.addEventListener("pointerdown", this.pointerDown, true);
        view.dom.ownerDocument.addEventListener("pointerup", this.pointerUp);
        view.dom.ownerDocument.addEventListener(
          "pointercancel",
          this.pointerUp,
        );
        this.window.addEventListener("blur", this.settle);
      }

      private pointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || !event.isPrimary) return;
        if (this.revealFrame !== undefined)
          this.window.cancelAnimationFrame(this.revealFrame);
        this.revealFrame = undefined;
        this.pointerId = event.pointerId;
      };

      private pointerUp = (event: PointerEvent) => {
        if (event.pointerId === this.pointerId) this.settle();
      };

      private settle = () => {
        if (this.pointerId === undefined || this.revealFrame !== undefined)
          return;
        // Mouse-up and CodeMirror's selection handling must finish before geometry changes.
        this.revealFrame = this.window.requestAnimationFrame(() => {
          this.revealFrame = undefined;
          this.pointerId = undefined;
          this.view.dispatch({ effects: settlePointer.of(undefined) });
        });
      };

      destroy() {
        const { view } = this;
        view.dom.removeEventListener("pointerdown", this.pointerDown, true);
        view.dom.ownerDocument.removeEventListener("pointerup", this.pointerUp);
        view.dom.ownerDocument.removeEventListener(
          "pointercancel",
          this.pointerUp,
        );
        this.window.removeEventListener("blur", this.settle);
        if (this.revealFrame !== undefined)
          this.window.cancelAnimationFrame(this.revealFrame);
      }

      update(update: ViewUpdate) {
        if (this.pointerId !== undefined) {
          this.decorations = this.decorations.map(update.changes);
          return;
        }
        if (
          update.transactions.some((tr) =>
            tr.effects.some((effect) => effect.is(settlePointer)),
          ) ||
          update.docChanged ||
          update.selectionSet ||
          update.focusChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = decorate(update.view, resources);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

function decorate(view: EditorView, resources: MarkdownResources | undefined) {
  const { state } = view;
  const decorations: Range<Decoration>[] = [];
  const active = (from: number, to: number) =>
    view.hasFocus &&
    state.facet(EditorView.editable) &&
    state.selection.ranges.some((range) =>
      range.empty
        ? range.head > from && range.head < to
        : range.from < to && range.to > from,
    );
  const marker = (from: number, to: number, visible: boolean) => {
    // View-plugin replacements cannot hide line breaks; retain that source.
    if (
      from >= to ||
      state.doc.lineAt(from).number !== state.doc.lineAt(to).number
    )
      return;
    decorations.push(
      (visible
        ? Decoration.mark({ class: "markdown-marker" })
        : Decoration.replace({})
      ).range(from, to),
    );
  };
  syntaxTree(state).iterate({
    enter: ({ node }) => {
      const tagName =
        node.name === "StrongEmphasis"
          ? "strong"
          : node.name === "Emphasis"
            ? "em"
            : node.name === "InlineCode"
              ? "code"
              : node.name === "Strikethrough"
                ? "s"
                : undefined;
      if (tagName !== undefined) {
        const first = node.firstChild;
        const last = node.lastChild;
        if (first === null || last === null || first === last) return;
        const visible = active(node.from, node.to);
        marker(first.from, first.to, visible);
        marker(last.from, last.to, visible);
        if (first.to < last.from) {
          decorations.push(
            Decoration.mark({ tagName }).range(first.to, last.from),
          );
        }
      }
      if (node.name === "Link" || node.name === "Image") {
        const paragraph = marked.lexer(state.sliceDoc(node.from, node.to))[0];
        const token =
          paragraph?.type === "paragraph" ? paragraph.tokens?.[0] : undefined;
        if (
          token?.type === "image" &&
          !active(node.from, node.to) &&
          state.doc.lineAt(node.from).number ===
            state.doc.lineAt(node.to).number
        ) {
          decorations.push(
            Decoration.replace({
              widget: new MarkdownImageWidget({
                source: token.href,
                alt: token.text,
                resources,
              }),
            }).range(node.from, node.to),
          );
          return false;
        }
        if (token?.type === "link") {
          const brackets = node.getChildren("LinkMark");
          const first = brackets[0];
          const second = brackets[1];
          if (first !== undefined && second !== undefined) {
            const visible = active(node.from, node.to);
            marker(first.from, first.to, visible);
            marker(second.from, node.to, visible);
            decorations.push(
              Decoration.mark({
                tagName: "a",
                attributes: /^(?:https?:\/\/|\/\/)/i.test(token.href)
                  ? { href: token.href }
                  : {},
              }).range(first.to, second.from),
            );
          }
        }
      }
      if (node.name === "Escape")
        marker(node.from, node.from + 1, active(node.from, node.to));
      const heading = /^ATXHeading([1-6])$/.exec(node.name);
      if (heading !== null) {
        decorations.push(
          Decoration.line({
            attributes: {
              class: `markdown-heading markdown-heading-${heading[1]}`,
              role: "heading",
              "aria-level": heading[1]!,
            },
          }).range(state.doc.lineAt(node.from).from),
        );
        const visible =
          view.hasFocus &&
          state.selection.ranges.some(
            (range) => range.head >= node.from && range.head <= node.to,
          );
        for (const mark of node.getChildren("HeaderMark")) {
          const end =
            mark.from === node.from &&
            state.sliceDoc(mark.to, mark.to + 1) === " "
              ? mark.to + 1
              : mark.to;
          marker(mark.from, end, visible);
        }
      }
    },
  });
  return Decoration.set(decorations, true);
}

const editorStyle = style({
  width: "100%",
  minHeight: "100%",
  "& .cm-editor": {
    fontFamily,
    fontSize: "inherit",
    background: "transparent",
  },
  "& .cm-editor.cm-focused": { outline: "none" },
  "& .cm-scroller": {
    fontFamily: "inherit",
    lineHeight: 1.6,
    overflow: "visible",
  },
  "& .cm-content": {
    padding: 0,
    minHeight: "2.75em",
    caretColor: "currentColor",
  },
  "& .cm-line": { padding: 0 },
  "& .cm-cursor": { borderLeftColor: "currentColor" },
  "& .cm-placeholder, & .markdown-marker": { color: colors.gray[9] },
  "& .markdown-marker": { fontWeight: "normal", fontStyle: "normal" },
  "& .markdown-heading": { fontWeight: 600, lineHeight: 1.4 },
  "& .markdown-heading-1": { fontSize: "2em" },
  "& .markdown-heading-2": { fontSize: "1.5em" },
  "& .markdown-heading-3": { fontSize: "1.25em" },
  "& .markdown-image": {
    maxWidth: "100%",
    maxHeight: "32rem",
    verticalAlign: "middle",
  },
  "& a": { color: colors.blue[11], textDecoration: "underline" },
  "& code": {
    fontFamily: monoFontFamily,
    background: colors.grayAlpha[3],
    borderRadius: "3px",
  },
});

function toggleInline(view: EditorView, type: string, marker: string) {
  const { state } = view;
  const { from, to, head } = state.selection.main;
  for (
    let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(
      state,
    ).resolveInner(head, -1);
    node !== null;
    node = node.parent
  ) {
    if (node.name !== type || from < node.from || to > node.to) continue;
    const first = node.firstChild;
    const last = node.lastChild;
    if (first === null || last === null) return false;
    view.dispatch({
      changes: [
        { from: first.from, to: first.to },
        { from: last.from, to: last.to },
      ],
      userEvent: "input.format",
    });
    return true;
  }
  const text = state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: marker + text + marker },
    selection: {
      anchor: from + marker.length,
      head: from + marker.length + text.length,
    },
    userEvent: "input.format",
  });
  return true;
}
