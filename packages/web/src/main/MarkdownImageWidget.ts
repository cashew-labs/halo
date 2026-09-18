import { WidgetType, type EditorView } from "@codemirror/view";
import type { HaloClient } from "@get-halo/client";
import * as errore from "errore";

export type MarkdownResources = {
  api: HaloClient;
  documentPath: string;
  onError(message: string | undefined): void;
};

export class MarkdownImageError extends errore.createTaggedError({
  name: "MarkdownImageError",
  message: "Could not $operation image.",
}) {}

export class MarkdownImageWidget extends WidgetType {
  private readonly source: string;
  private readonly alt: string;
  private readonly resources: MarkdownResources | undefined;

  constructor(ctx: {
    source: string;
    alt: string;
    resources: MarkdownResources | undefined;
  }) {
    super();
    this.source = ctx.source;
    this.alt = ctx.alt;
    this.resources = ctx.resources;
  }

  eq(other: MarkdownImageWidget) {
    return other.source === this.source && other.alt === this.alt;
  }

  toDOM(view: EditorView) {
    const dom = document.createElement("img");
    dom.alt = this.alt;
    dom.className = "markdown-image";
    dom.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(dom) + 2 } });
      view.focus();
    });
    void this.load(dom).catch(console.error);
    return dom;
  }

  private async load(dom: HTMLImageElement) {
    if (/^(?:https?:|data:|blob:|\/\/)/i.test(this.source)) {
      dom.src = this.source;
      return;
    }
    if (this.resources === undefined) return;
    const { api, documentPath, onError } = this.resources;
    const path = errore.try({
      try: () => {
        const base = new URL(
          documentPath.split("/").map(encodeURIComponent).join("/"),
          "https://workspace.invalid/",
        );
        return decodeURIComponent(new URL(this.source, base).pathname.slice(1));
      },
      catch: (cause) => new MarkdownImageError({ operation: "resolve", cause }),
    });
    if (path instanceof Error) {
      console.warn(path);
      onError(path.message);
      return;
    }
    const preview = await api.workspace
      .previewFile({ path })
      .catch((cause) => new MarkdownImageError({ operation: "load", cause }));
    if (dom.dataset.disposed === "true") return;
    if (preview instanceof Error) {
      console.warn(preview);
      onError(preview.message);
      return;
    }
    if (preview.kind !== "image") return;
    dom.src = URL.createObjectURL(preview.file);
    dom.dataset.objectUrl = dom.src;
  }

  destroy(dom: HTMLElement) {
    dom.dataset.disposed = "true";
    if (dom.dataset.objectUrl !== undefined)
      URL.revokeObjectURL(dom.dataset.objectUrl);
  }
}
