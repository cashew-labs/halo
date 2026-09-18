import { isolateHistory } from "@codemirror/commands";
import { StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { imageFilename } from "@get-halo/client";
import {
  MarkdownImageError,
  type MarkdownResources,
} from "./MarkdownImageWidget.js";

const insertPlaceholder = StateEffect.define<{ id: string; pos: number }>();
const removePlaceholder = StateEffect.define<string>();
class ImagePlaceholder extends WidgetType {
  toDOM() {
    const dom = document.createElement("span");
    dom.textContent = "Saving image…";
    dom.setAttribute("role", "status");
    return dom;
  }
}
const placeholders = StateField.define({
  create: () => Decoration.none,
  update(decorations, tr) {
    // Undo owns document content. Upload completion must never reinsert it.
    let result = tr.isUserEvent("undo")
      ? Decoration.none
      : decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(insertPlaceholder)) {
        result = result.update({
          add: [
            Decoration.widget({
              widget: new ImagePlaceholder(),
              id: effect.value.id,
            }).range(effect.value.pos),
          ],
          sort: true,
        });
      }
      if (effect.is(removePlaceholder))
        result = result.update({
          filter: (_from, _to, value) => value.spec.id !== effect.value,
        });
    }
    return result;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function markdownImagePaste(resources: MarkdownResources) {
  return [
    placeholders,
    EditorView.domEventHandlers({
      paste(event, view) {
        const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
          file.type.startsWith("image/"),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        resources.onError(undefined);
        const images = files.flatMap((file) => {
          const id = crypto.randomUUID();
          const src = imageFilename({ id, mime: file.type });
          if (src === undefined) {
            const error = new MarkdownImageError({
              operation: "paste",
              cause: new Error(`Unsupported image type: ${file.type}`),
            });
            console.warn(error);
            resources.onError(error.message);
            return [];
          }
          resources.localImages?.set(src, file);
          const alt = file.name
            .replaceAll(/([\\[\]])/g, "\\$1")
            .replaceAll(/\r?\n/g, " ");
          return [{ id, file, markdown: `![${alt}](${src})` }];
        });
        if (images.length === 0) return true;
        const { from, to } = view.state.selection.main;
        const insert = images.map((image) => image.markdown).join("\n\n");
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
          effects: images.map(({ id }) =>
            insertPlaceholder.of({ id, pos: from + insert.length }),
          ),
          annotations: isolateHistory.of("full"),
          userEvent: "input.paste",
        });
        for (const { id, file } of images)
          void save({ id, file, view, resources }).catch(console.error);
        return true;
      },
    }),
  ];
}

async function save({
  id,
  file,
  view,
  resources,
}: {
  id: string;
  file: File;
  view: EditorView;
  resources: MarkdownResources;
}) {
  const result = await resources.api.workspace
    .saveImage({ documentPath: resources.documentPath, file, id })
    .catch((cause) => new MarkdownImageError({ operation: "paste", cause }));
  if (!view.dom.isConnected) return;
  if (result instanceof Error) {
    console.warn(result);
    resources.onError(result.message);
  }
  view.dispatch({
    effects: removePlaceholder.of(id),
    annotations: Transaction.addToHistory.of(false),
  });
}
