import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { colors, motionDurationMs, motionEasing } from "maui";

// Whim's animated caret and hover preview, owned by the Tiptap plugin view.
export const EditorCursor = Extension.create({
  name: "editorCursor",
  addProseMirrorPlugins() {
    return [new Plugin({ view: (view) => new CursorView({ view }) })];
  },
});

type Caret = {
  left: number;
  top: number;
  height: number;
  bold: boolean;
  italic: boolean;
};

class CursorView {
  private frame: number | undefined;
  private blink: Animation | undefined;
  private lastCaret: Caret | undefined;
  private animate = false;
  private lastDoc: EditorView["state"]["doc"] | undefined;
  private composing = false;
  private readonly view: EditorView;
  private readonly document: Document;
  private readonly window: Window;
  private readonly layer: HTMLDivElement;
  private readonly caret: HTMLDivElement;
  private readonly preview: HTMLDivElement;
  private readonly resize: ResizeObserver;
  private readonly reducedMotion: MediaQueryList;
  private readonly mouseInput: MediaQueryList;

  constructor(ctx: { view: EditorView }) {
    this.view = ctx.view;
    this.document = ctx.view.dom.ownerDocument;
    this.window = this.document.defaultView!;
    this.reducedMotion = this.window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    // Keep the native caret and selection UI on touch-first devices. Mobile
    // viewport panning/zooming can offset a fixed overlay from the text.
    this.mouseInput = this.window.matchMedia(
      "(hover: hover) and (pointer: fine)",
    );
    this.mouseInput.addEventListener("change", this.scrolled);
    this.layer = this.document.createElement("div");
    this.layer.setAttribute("aria-hidden", "true");
    Object.assign(this.layer.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "1",
      overflow: "hidden",
    });
    this.caret = this.createCaret("halo-editor-caret", colors.accent[11]);
    this.preview = this.createCaret("halo-editor-hover-caret", colors.gray[12]);
    this.layer.append(this.caret, this.preview);
    this.document.body.appendChild(this.layer);
    this.document.addEventListener("selectionchange", this.selectionChanged);
    this.document.addEventListener("focusin", this.schedule);
    this.document.addEventListener("focusout", this.schedule);
    this.document.addEventListener("scroll", this.scrolled, true);
    this.window.addEventListener("resize", this.scrolled);
    this.window.addEventListener("blur", this.hide);
    this.window.addEventListener("focus", this.schedule);
    this.view.dom.addEventListener("pointermove", this.pointerMove);
    this.view.dom.addEventListener("pointerleave", this.hidePreview);
    this.view.dom.addEventListener("keydown", this.hidePreview);
    this.view.dom.addEventListener("compositionstart", this.compositionStart);
    this.view.dom.addEventListener("compositionend", this.compositionEnd);
    this.resize = new ResizeObserver(this.scrolled);
    this.resize.observe(this.view.dom);
    this.schedule();
  }

  private createCaret(className: string, backgroundColor: string) {
    const element = this.document.createElement("div");
    element.className = className;
    Object.assign(element.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "2px",
      backgroundColor,
      borderRadius: "1px",
      transformOrigin: "center",
      display: "none",
    });
    return element;
  }

  update(view: EditorView, previous: EditorView["state"]) {
    this.animate =
      previous.doc === view.state.doc &&
      (this.animate || !previous.selection.eq(view.state.selection));
    this.schedule();
  }

  private selectionChanged = () => {
    this.animate = this.lastDoc === this.view.state.doc;
    this.schedule();
  };

  private schedule = () => {
    if (this.frame !== undefined) return;
    this.frame = this.window.requestAnimationFrame(() => {
      this.frame = undefined;
      this.render();
    });
  };

  private scrolled = () => {
    this.animate = false;
    this.hidePreview();
    this.schedule();
  };

  private compositionStart = () => {
    this.composing = true;
    this.hide();
  };
  private compositionEnd = () => {
    this.composing = false;
    this.schedule();
  };

  private nativeCaret() {
    const selection = this.document.getSelection();
    if (
      selection === null ||
      !selection.isCollapsed ||
      selection.rangeCount === 0 ||
      !this.view.dom.contains(selection.anchorNode)
    )
      return undefined;
    const range = selection.getRangeAt(0);
    const element =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement;
    if (element === null || element === undefined) return undefined;
    const rect = range.getClientRects()[0];
    const style = this.window.getComputedStyle(element);
    if (rect !== undefined && rect.height > 0)
      return this.caretAt(rect.left, rect.top, rect.height, style);
    // Empty source fields have no native range rect; use their text box.
    if (element.closest(".markdown-source")) {
      const box = element.getBoundingClientRect();
      return this.caretAt(
        box.left,
        box.top,
        Number.parseFloat(style.fontSize),
        style,
      );
    }
    const coords = this.view.coordsAtPos(this.view.state.selection.head);
    return this.caretAt(
      coords.left,
      coords.top,
      coords.bottom - coords.top,
      style,
    );
  }

  private caretAt(
    left: number,
    top: number,
    height: number,
    style: CSSStyleDeclaration,
  ): Caret {
    return {
      left,
      top,
      height,
      bold:
        Number.parseInt(style.fontWeight) >= 600 || style.fontWeight === "bold",
      italic: style.fontStyle === "italic",
    };
  }

  private paint(element: HTMLDivElement, caret: Caret) {
    element.style.height = `${caret.height}px`;
    element.style.width = caret.bold ? "3px" : "2px";
    element.style.transform = `translate(${caret.left}px, ${caret.top}px) skewX(${caret.italic ? "-12deg" : "0deg"})`;
    element.style.display = "block";
  }

  private render() {
    if (
      !this.mouseInput.matches ||
      !this.view.editable ||
      this.composing ||
      this.view.composing ||
      !this.document.hasFocus() ||
      !this.view.dom.contains(this.document.activeElement)
    ) {
      this.hide();
      return;
    }
    const caret = this.nativeCaret();
    if (caret === undefined) {
      this.hide();
      return;
    }
    this.clipLayer();
    const moved =
      this.lastCaret === undefined ||
      caret.left !== this.lastCaret.left ||
      caret.top !== this.lastCaret.top ||
      caret.height !== this.lastCaret.height;
    if (moved) {
      this.caret.style.transition =
        this.animate &&
        this.lastCaret !== undefined &&
        !this.reducedMotion.matches
          ? `transform ${motionDurationMs}ms ${motionEasing}`
          : "none";
    }
    this.paint(this.caret, caret);
    this.view.dom.classList.add("halo-custom-caret");
    if (moved || this.blink === undefined) {
      this.blink?.cancel();
      this.blink = this.caret.animate(
        [
          { opacity: 1 },
          { opacity: 1, offset: 0.5 },
          { opacity: 0, offset: 0.51 },
          { opacity: 0 },
        ],
        { duration: 1000, iterations: Infinity },
      );
    }
    this.lastCaret = caret;
    this.lastDoc = this.view.state.doc;
    this.animate = false;
  }

  private clipLayer() {
    const box = this.view.dom.getBoundingClientRect();
    // Clip to both the editor and its scrolling ancestors.
    let top = Math.max(0, box.top),
      left = Math.max(0, box.left);
    let bottom = Math.min(this.window.innerHeight, box.bottom),
      right = Math.min(this.window.innerWidth, box.right);
    for (
      let parent = this.view.dom.parentElement;
      parent !== null;
      parent = parent.parentElement
    ) {
      const style = this.window.getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      if (style.overflowY !== "visible") {
        top = Math.max(top, rect.top);
        bottom = Math.min(bottom, rect.bottom);
      }
      if (style.overflowX !== "visible") {
        left = Math.max(left, rect.left);
        right = Math.min(right, rect.right);
      }
    }
    this.layer.style.clipPath = `inset(${top}px ${this.window.innerWidth - right}px ${this.window.innerHeight - bottom}px ${left}px)`;
  }

  private pointerMove = (event: PointerEvent) => {
    if (
      !this.mouseInput.matches ||
      !this.view.editable ||
      event.pointerType !== "mouse" ||
      event.buttons !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      this.composing
    ) {
      this.hidePreview();
      return;
    }
    const element = event.target instanceof Element ? event.target : undefined;
    if (element === undefined || element.closest("a, input, button, img")) {
      this.hidePreview();
      return;
    }
    const range = this.document.caretRangeFromPoint(
      event.clientX,
      event.clientY,
    );
    if (range === null || !this.view.dom.contains(range.startContainer)) {
      this.hidePreview();
      return;
    }
    const rect = range.getClientRects()[0];
    if (
      rect === undefined ||
      rect.height === 0 ||
      Math.abs(event.clientX - rect.left) > 8 ||
      event.clientY < rect.top - 8 ||
      event.clientY > rect.bottom + 8
    ) {
      this.hidePreview();
      return;
    }
    const parent =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    if (parent === null) {
      this.hidePreview();
      return;
    }
    const caret = this.caretAt(
      rect.left + (event.clientX - rect.left) * 0.12,
      rect.top,
      rect.height,
      this.window.getComputedStyle(parent),
    );
    this.clipLayer();
    this.paint(this.preview, caret);
    this.preview.style.opacity = "0.5";
    this.view.dom.classList.add("halo-hover-caret");
  };

  private hidePreview = () => {
    this.preview.style.display = "none";
    this.view.dom.classList.remove("halo-hover-caret");
  };

  private hide = () => {
    this.caret.style.display = "none";
    this.view.dom.classList.remove("halo-custom-caret");
    this.hidePreview();
    this.blink?.cancel();
    this.blink = undefined;
    this.lastCaret = undefined;
  };

  destroy() {
    if (this.frame !== undefined) this.window.cancelAnimationFrame(this.frame);
    this.hide();
    this.resize.disconnect();
    this.mouseInput.removeEventListener("change", this.scrolled);
    this.document.removeEventListener("selectionchange", this.selectionChanged);
    this.document.removeEventListener("focusin", this.schedule);
    this.document.removeEventListener("focusout", this.schedule);
    this.document.removeEventListener("scroll", this.scrolled, true);
    this.window.removeEventListener("resize", this.scrolled);
    this.window.removeEventListener("blur", this.hide);
    this.window.removeEventListener("focus", this.schedule);
    this.view.dom.removeEventListener("pointermove", this.pointerMove);
    this.view.dom.removeEventListener("pointerleave", this.hidePreview);
    this.view.dom.removeEventListener("keydown", this.hidePreview);
    this.view.dom.removeEventListener(
      "compositionstart",
      this.compositionStart,
    );
    this.view.dom.removeEventListener("compositionend", this.compositionEnd);
    this.layer.remove();
  }
}
