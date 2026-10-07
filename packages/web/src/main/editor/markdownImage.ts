import Image from "@tiptap/extension-image";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { colors } from "maui";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import * as errore from "errore";
import type { HaloClient } from "@get-halo/client";

class MarkdownImageError extends errore.createTaggedError({
  name: "MarkdownImageError",
  message: "Could not $operation image.",
}) {}

type PastePlaceholder =
  | { add: { id: string; pos: number } }
  | { remove: string };

export function markdownImage(options: {
  client: { current: HaloClient };
  documentPath: string;
  copyMenuClassName: string;
  onError: (message: string | undefined) => void;
}) {
  const { client, documentPath, copyMenuClassName, onError } = options;
  const placeholders = new PluginKey<DecorationSet>("imagePaste");
  const dropPreview = new PluginKey<number | undefined>("imageDropPreview");
  const previews = new Map<string, File>();
  let copyMenu:
    | { button: HTMLButtonElement; image: HTMLImageElement; close: () => void }
    | undefined;

  const copyImage = (image: HTMLImageElement) => {
    if (!image.complete || image.naturalWidth === 0) return;
    const source = image.getAttribute("data-markdown-src");
    const cached = source === null ? undefined : previews.get(source);
    const png =
      cached?.type === "image/png"
        ? cached
        : new Promise<Blob>((resolve, reject) => {
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext("2d");
            if (context === null) {
              reject(new MarkdownImageError({ operation: "copy" }));
              return;
            }
            context.drawImage(image, 0, 0);
            canvas.toBlob((blob) => {
              if (blob === null)
                reject(new MarkdownImageError({ operation: "copy" }));
              else resolve(blob);
            }, "image/png");
          });
    onError(undefined);
    void navigator.clipboard
      .write([new ClipboardItem({ "image/png": png })])
      .catch((cause) => {
        const error = new MarkdownImageError({ operation: "copy", cause });
        console.warn(error);
        onError("Could not copy image. Please try again.");
      });
  };

  const showCopyMenu = (
    view: EditorView,
    image: HTMLImageElement,
    x: number,
    y: number,
  ) => {
    copyMenu?.close();
    const button = document.createElement("button");
    button.type = "button";
    button.className = copyMenuClassName;
    button.contentEditable = "false";
    button.setAttribute("aria-label", "Copy image");
    button.title = "Copy image";
    button.textContent = "⧉ Copy image";
    button.style.left = `${x}px`;
    button.style.top = `${y}px`;
    const listeners = new AbortController();
    const close = () => {
      listeners.abort();
      button.remove();
      if (copyMenu?.button === button) copyMenu = undefined;
    };
    button.addEventListener("click", () => {
      copyImage(image);
      close();
    });
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!(event.target instanceof Node) || !button.contains(event.target))
          close();
      },
      { signal: listeners.signal },
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") close();
      },
      { signal: listeners.signal },
    );
    document.addEventListener("scroll", close, {
      capture: true,
      signal: listeners.signal,
    });
    (view.dom.parentElement ?? document.body).append(button);
    copyMenu = { button, image, close };
    button.focus();
  };

  return Image.extend({
    renderMarkdown(node, helpers, context) {
      const alt: string | null | undefined = node.attrs?.alt;
      const attrs = {
        ...node.attrs,
        alt: alt?.replaceAll(/([\\[\]])/g, "\\$1"),
      };
      // SAFETY: Tiptap's Image defines this serializer, but leaves alt text unescaped.
      return Image.config.renderMarkdown!({ ...node, attrs }, helpers, context);
    },

    addNodeView() {
      return ({ HTMLAttributes }) => {
        const dom = document.createElement("img");
        for (const [key, value] of Object.entries(HTMLAttributes)) {
          if (key !== "src" && value !== null) dom.setAttribute(key, value);
        }
        const src: string = HTMLAttributes.src;
        dom.setAttribute("data-markdown-src", src);
        let objectUrl: string | undefined;
        let destroyed = false;
        const showPreview = (file: File) => {
          objectUrl = URL.createObjectURL(file);
          dom.src = objectUrl;
        };
        const load = async () => {
          if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) {
            dom.src = src;
            return;
          }
          const cached = previews.get(src);
          if (cached !== undefined) {
            showPreview(cached);
            return;
          }
          const base = new URL(
            documentPath.split("/").map(encodeURIComponent).join("/"),
            "https://workspace.invalid/",
          );
          const path = decodeURIComponent(new URL(src, base).pathname.slice(1));
          const preview = await client.current.workspace
            .previewFile({ path })
            .catch(
              (cause) => new MarkdownImageError({ operation: "load", cause }),
            );
          if (destroyed) return;
          if (preview instanceof Error) {
            console.warn(preview);
            dom.title = preview.message;
            return;
          }
          if (preview.kind !== "image") return;
          previews.set(src, preview.file);
          showPreview(preview.file);
        };
        void load().catch(console.error);
        return {
          dom,
          destroy() {
            destroyed = true;
            if (copyMenu?.image === dom) copyMenu.close();
            if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
          },
        };
      };
    },

    addProseMirrorPlugins() {
      const editor = this.editor;
      const insertImages = (
        view: EditorView,
        files: File[],
        position?: number,
      ) => {
        onError(undefined);
        const id = crypto.randomUUID();
        const tr = view.state.tr;
        if (position === undefined) tr.deleteSelection();
        view.dispatch(
          tr.setMeta(placeholders, {
            add: { id, pos: position ?? tr.selection.from },
          }),
        );
        const save = async () => {
          const results = await Promise.all(
            files.map(async (file) => {
              const saved = await client.current.workspace
                .saveImage({ documentPath, file })
                .catch(
                  (cause) =>
                    new MarkdownImageError({ operation: "save", cause }),
                );
              if (saved instanceof Error) return saved;
              return this.type.create({ src: saved.src, alt: file.name });
            }),
          );
          if (this.editor.isDestroyed) return;
          const placeholder = placeholders
            .getState(view.state)
            ?.find(undefined, undefined, (spec) => spec.id === id)[0];
          const [images, errors] = errore.partition(results);
          for (const error of errors) {
            console.warn(error);
            onError("Could not save image. Please try again.");
          }
          const transaction = view.state.tr.setMeta(placeholders, {
            remove: id,
          });
          if (placeholder !== undefined)
            transaction.insert(placeholder.from, images);
          view.dispatch(transaction);
        };
        void save().catch(console.error);
      };
      const clearPreview = (view: EditorView) => {
        if (dropPreview.getState(view.state) !== undefined) {
          view.dispatch(
            view.state.tr
              .setMeta(dropPreview, { position: undefined })
              .setMeta("addToHistory", false),
          );
        }
      };
      return [
        new Plugin<number | undefined>({
          key: dropPreview,
          state: {
            init: () => undefined,
            apply(tr, position) {
              const action: { position: number | undefined } | undefined =
                tr.getMeta(dropPreview);
              if (action !== undefined) return action.position;
              return position === undefined
                ? undefined
                : tr.mapping.map(position);
            },
          },
          props: {
            decorations(state) {
              const position = dropPreview.getState(state);
              if (position === undefined) return DecorationSet.empty;
              const marker = document.createElement("span");
              marker.setAttribute("aria-hidden", "true");
              marker.className = "halo-image-drop-preview";
              Object.assign(marker.style, {
                display: "inline-block",
                width: "3px",
                height: "1em",
                verticalAlign: "text-bottom",
                backgroundColor: colors.accent[9],
                pointerEvents: "none",
              });
              return DecorationSet.create(state.doc, [
                Decoration.widget(position, marker),
              ]);
            },
            handleDOMEvents: {
              dragover(view, event) {
                if (
                  !editor.isEditable ||
                  !event.dataTransfer?.types.includes("Files")
                )
                  return false;
                const position = view.posAtCoords({
                  left: event.clientX,
                  top: event.clientY,
                })?.pos;
                if (position === undefined) return false;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                if (position !== dropPreview.getState(view.state)) {
                  view.dispatch(
                    view.state.tr
                      .setMeta(dropPreview, { position })
                      .setMeta("addToHistory", false),
                  );
                }
                return true;
              },
              dragleave(view, event) {
                if (
                  !(event.relatedTarget instanceof Node) ||
                  !view.dom.contains(event.relatedTarget)
                )
                  clearPreview(view);
                return false;
              },
            },
            handleDrop: (view, event, _slice, moved) => {
              const position =
                dropPreview.getState(view.state) ??
                view.posAtCoords({ left: event.clientX, top: event.clientY })
                  ?.pos;
              clearPreview(view);
              if (
                moved ||
                !this.editor.isEditable ||
                event.dataTransfer === null ||
                position === undefined
              )
                return false;
              const files = [...event.dataTransfer.files].filter((file) =>
                file.type.startsWith("image/"),
              );
              if (files.length === 0) return false;
              event.preventDefault();
              insertImages(view, files, position);
              return true;
            },
          },
        }),
        new Plugin<DecorationSet>({
          key: placeholders,
          state: {
            init: () => DecorationSet.empty,
            apply(tr, decorations) {
              const mapped = decorations.map(tr.mapping, tr.doc);
              const action: PastePlaceholder | undefined =
                tr.getMeta(placeholders);
              if (action === undefined) return mapped;
              if ("remove" in action) {
                return mapped.remove(
                  mapped.find(
                    undefined,
                    undefined,
                    (spec) => spec.id === action.remove,
                  ),
                );
              }
              const dom = document.createElement("span");
              dom.textContent = "Saving image…";
              dom.setAttribute("role", "status");
              return mapped.add(tr.doc, [
                Decoration.widget(action.add.pos, dom, {
                  id: action.add.id,
                  side: -1,
                }),
              ]);
            },
          },
          props: {
            decorations: (state) => placeholders.getState(state),
            handleKeyDown: (view, event) => {
              if (
                !(event.metaKey || event.ctrlKey) ||
                event.key.toLowerCase() !== "c" ||
                !(view.state.selection instanceof NodeSelection) ||
                view.state.selection.node.type.name !== "image"
              )
                return false;
              const image = view.nodeDOM(view.state.selection.from);
              if (!(image instanceof HTMLImageElement)) return false;
              copyImage(image);
              return true;
            },
            handleDOMEvents: {
              contextmenu(view, event) {
                const image = event.target;
                if (
                  !(image instanceof HTMLImageElement) ||
                  !view.dom.contains(image)
                )
                  return false;
                event.preventDefault();
                showCopyMenu(view, image, event.clientX, event.clientY);
                return true;
              },
            },
            handlePaste: (view, event) => {
              if (event.clipboardData === null) return false;
              const files = [...event.clipboardData.files].filter((file) =>
                file.type.startsWith("image/"),
              );
              if (files.length === 0) return false;
              insertImages(view, files);
              return true;
            },
          },
        }),
      ];
    },
  }).configure({ inline: true, allowBase64: true });
}
