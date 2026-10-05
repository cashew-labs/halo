import Image from "@tiptap/extension-image";
import { Plugin, PluginKey } from "@tiptap/pm/state";
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
  onError: (message: string | undefined) => void;
}) {
  const { client, documentPath, onError } = options;
  const placeholders = new PluginKey<DecorationSet>("imagePaste");

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
        let objectUrl: string | undefined;
        let destroyed = false;
        const load = async () => {
          if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) {
            dom.src = src;
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
          objectUrl = URL.createObjectURL(preview.file);
          dom.src = objectUrl;
        };
        void load().catch(console.error);
        return {
          dom,
          destroy() {
            destroyed = true;
            if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
          },
        };
      };
    },

    addProseMirrorPlugins() {
      return [
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
            handlePaste: (view, event) => {
              if (event.clipboardData === null) return false;
              const files = [...event.clipboardData.files].filter((file) =>
                file.type.startsWith("image/"),
              );
              if (files.length === 0) return false;
              onError(undefined);
              const id = crypto.randomUUID();
              const tr = view.state.tr.deleteSelection();
              view.dispatch(
                tr.setMeta(placeholders, {
                  add: { id, pos: tr.selection.from },
                }),
              );
              const save = async () => {
                const results = await Promise.all(
                  files.map(async (file) => {
                    const saved = await client.current.workspace
                      .saveImage({ documentPath, file })
                      .catch(
                        (cause) =>
                          new MarkdownImageError({ operation: "paste", cause }),
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
                  onError("Could not paste image. Please try again.");
                }
                const transaction = view.state.tr.setMeta(placeholders, {
                  remove: id,
                });
                if (placeholder !== undefined)
                  transaction.insert(placeholder.from, images);
                view.dispatch(transaction);
              };
              void save().catch(console.error);
              return true;
            },
          },
        }),
      ];
    },
  }).configure({ inline: true, allowBase64: true });
}
