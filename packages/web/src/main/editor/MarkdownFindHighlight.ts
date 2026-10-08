import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

type HighlightRange = { from: number; to: number };
const highlightKey = new PluginKey<HighlightRange | undefined>(
  "markdownFindHighlight",
);

export const MarkdownFindHighlight = Extension.create({
  name: "markdownFindHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin<HighlightRange | undefined>({
        key: highlightKey,
        state: {
          init: () => undefined,
          apply(transaction, active) {
            // SAFETY: only this module writes this plugin key with a range field.
            const change = transaction.getMeta(highlightKey) as
              | { range: HighlightRange | undefined }
              | undefined;
            if (change !== undefined) return change.range;
            return transaction.docChanged ? undefined : active;
          },
        },
        props: {
          decorations(state) {
            const active = highlightKey.getState(state);
            if (active === undefined) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [
              Decoration.inline(active.from, active.to, {
                class: "halo-find-active-match",
              }),
            ]);
          },
        },
      }),
    ];
  },
});

export function setMarkdownFindHighlight(
  editor: Editor,
  range: HighlightRange | undefined,
) {
  if (editor.isDestroyed) return;
  const current = highlightKey.getState(editor.state);
  if (current?.from === range?.from && current?.to === range?.to) return;
  editor.view.dispatch(editor.state.tr.setMeta(highlightKey, { range }));
}
