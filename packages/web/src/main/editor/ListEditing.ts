import { Extension } from "@tiptap/core";
import { liftListItem } from "@tiptap/pm/schema-list";
import { Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import { canJoin } from "@tiptap/pm/transform";

export const ListEditing = Extension.create({
  name: "listEditing",
  priority: 1000,

  onCreate() {
    const tr = joinAdjacentLists(this.editor.state.tr);
    if (tr.docChanged)
      this.editor.view.dispatch(tr.setMeta("addToHistory", false));
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return;
          const tr = joinAdjacentLists(state.tr);
          return tr.docChanged ? tr : undefined;
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    const itemType = () =>
      ["taskItem", "listItem"].find((name) => this.editor.isActive(name));
    return {
      Tab: () => {
        const name = itemType();
        if (name === undefined) return false;
        this.editor.commands.sinkListItem(name);
        return true;
      },
      "Shift-Tab": () => {
        const name = itemType();
        if (name === undefined) return false;
        this.editor.commands.liftListItem(name);
        return true;
      },
      Backspace: () => {
        const { state, view } = this.editor;
        const { selection } = state;
        if (
          !(selection instanceof TextSelection) ||
          !selection.empty ||
          selection.$from.parentOffset !== 0
        )
          return false;
        const { $from } = selection;
        if ($from.parent.type.name === "codeBlock")
          return this.editor.commands.setParagraph();
        const name = itemType();
        if (name !== undefined) {
          const itemDepth = $from.depth - 1;
          if (
            $from.node(itemDepth).type.name === name &&
            $from.index(itemDepth) === 0
          ) {
            return liftListItem(state.schema.nodes[name]!)(
              state,
              view.dispatch,
            );
          }
          return false;
        }
        if ($from.parent.type.name !== "paragraph" || $from.depth !== 1)
          return false;
        const before = $from.before();
        const previous = state.doc.resolve(before).nodeBefore;
        if (
          previous === null ||
          !["bulletList", "orderedList", "taskList"].includes(
            previous.type.name,
          )
        )
          return false;
        let last = previous;
        let insertAt = before - 1;
        while (!last.isTextblock && last.lastChild !== null) {
          last = last.lastChild;
          insertAt--;
        }
        if (
          !last.isTextblock ||
          !last.canReplace(
            last.childCount,
            last.childCount,
            $from.parent.content,
          )
        )
          return false;
        const tr = state.tr.deleteRange(before, $from.after());
        tr.insert(insertAt, $from.parent.content);
        tr.setSelection(TextSelection.create(tr.doc, insertAt));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    };
  },
});

function joinAdjacentLists(tr: Transaction) {
  const boundaries: number[] = [];
  tr.doc.descendants((node, pos) => {
    if (!["bulletList", "orderedList", "taskList"].includes(node.type.name))
      return;
    const previous = tr.doc.resolve(pos).nodeBefore;
    if (
      previous === null ||
      previous.type !== node.type ||
      !canJoin(tr.doc, pos)
    )
      return;
    const compatible =
      node.type.name === "orderedList"
        ? node.attrs.start === previous.attrs.start + previous.childCount
        : previous.sameMarkup(node);
    if (compatible) boundaries.push(pos);
  });
  boundaries.reduceRight((transaction, pos) => transaction.join(pos), tr);
  return tr;
}
