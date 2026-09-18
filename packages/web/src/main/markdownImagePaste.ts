import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import * as errore from "errore";
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
    let result = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(insertPlaceholder)) {
        result = result.update({
          add: [
            Decoration.widget({
              widget: new ImagePlaceholder(),
              id: effect.value.id,
            }).range(effect.value.pos),
          ],
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
        const id = crypto.randomUUID();
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to },
          effects: insertPlaceholder.of({ id, pos: from }),
        });
        void paste({ files, view, resources, id }).catch(console.error);
        return true;
      },
    }),
  ];
}

async function paste({
  files,
  view,
  resources,
  id,
}: {
  files: File[];
  view: EditorView;
  resources: MarkdownResources;
  id: string;
}) {
  const images = await Promise.all(
    files.map(async (file) => {
      const result = await resources.api.workspace
        .saveImage({ documentPath: resources.documentPath, file })
        .catch(
          (cause) => new MarkdownImageError({ operation: "paste", cause }),
        );
      if (result instanceof Error) return result;
      const alt = file.name
        .replaceAll(/([\\[\]])/g, "\\$1")
        .replaceAll(/\r?\n/g, " ");
      return `![${alt}](${result.src})`;
    }),
  );
  if (!view.dom.isConnected) return;
  const position: number[] = [];
  view.state
    .field(placeholders)
    .between(0, view.state.doc.length, (from, _to, value) => {
      if (value.spec.id === id) position.push(from);
    });
  const [saved, errors] = errore.partition(images);
  for (const error of errors) {
    console.warn(error);
    resources.onError(error.message);
  }
  const from = position[0];
  view.dispatch({
    changes:
      from === undefined ? undefined : { from, insert: saved.join("\n\n") },
    effects: removePlaceholder.of(id),
  });
}
