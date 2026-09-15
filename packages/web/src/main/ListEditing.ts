import { Extension } from "@tiptap/core";
import { Plugin, type Transaction } from "@tiptap/pm/state";

export const ListEditing = Extension.create({
  name: "listEditing",

  onCreate() {
    const tr = joinAdjacentBulletLists(this.editor.state.tr);
    if (tr.docChanged) {
      this.editor.view.dispatch(tr.setMeta("addToHistory", false));
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return;
          const tr = joinAdjacentBulletLists(state.tr);
          return tr.docChanged ? tr : undefined;
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (!this.editor.isActive("listItem")) return false;
        this.editor.commands.sinkListItem("listItem");
        return true;
      },
    };
  },
});

function joinAdjacentBulletLists(tr: Transaction) {
  // Tiptap can leave adjacent lists after deleting their separator or pasting.
  // ProseMirror's sinkListItem only indents siblings within a single list.
  const boundaries: number[] = [];
  tr.doc.descendants((node, pos) => {
    if (node.type.name !== "bulletList") return;
    if (tr.doc.resolve(pos).nodeBefore?.sameMarkup(node)) {
      boundaries.push(pos);
    }
  });
  boundaries.reduceRight((transaction, pos) => transaction.join(pos), tr);
  return tr;
}
