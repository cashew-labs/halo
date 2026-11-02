import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
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
    // A gesture belongs to the touched item, even when the caret is elsewhere.
    let swipe:
      | {
          x: number;
          y: number;
          time: number;
          doc: ProseMirrorNode;
          selection: TextSelection;
          name: string;
          handled: boolean;
        }
      | undefined;
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            beforeinput: (view, event) => {
              const { selection } = view.state;
              if (
                !view.editable ||
                !event.cancelable ||
                event.isComposing ||
                view.composing ||
                event.inputType !== "deleteContentBackward" ||
                !(selection instanceof TextSelection) ||
                !selection.empty ||
                selection.$from.parentOffset !== 0
              )
                return false;
              // Virtual keyboards can omit keydown. Handle structural deletion
              // before the browser mutates the DOM or schedules a fallback delete.
              const key = new KeyboardEvent("keydown", { key: "Backspace" });
              if (
                !view.someProp("handleKeyDown", (handler) => handler(view, key))
              )
                return false;
              event.preventDefault();
              return true;
            },
            touchstart: (view, event) => {
              swipe = undefined;
              if (
                !view.editable ||
                event.touches.length !== 1 ||
                !view.state.selection.empty ||
                !(event.target instanceof Element) ||
                event.target.closest(
                  "a, button, input, [contenteditable=false]",
                )
              )
                return false;
              const item = event.target.closest("li");
              if (item === null || !view.dom.contains(item)) return false;
              const position = view.posAtDOM(item, 0);
              const node = view.state.doc.resolve(position).parent;
              if (!["listItem", "taskItem"].includes(node.type.name))
                return false;
              const touch = event.touches[0]!;
              const { selection } = view.state;
              swipe = {
                x: touch.clientX,
                y: touch.clientY,
                time: event.timeStamp,
                doc: view.state.doc,
                selection:
                  selection instanceof TextSelection &&
                  selection.$from.sameParent(
                    view.state.doc.resolve(position + 1),
                  )
                    ? selection
                    : TextSelection.create(view.state.doc, position + 1),
                name: node.type.name,
                handled: false,
              };
              return false;
            },
            touchend: () => {
              swipe = undefined;
              return false;
            },
            touchcancel: () => {
              swipe = undefined;
              return false;
            },
          },
        },
        view: (view) => {
          const touchmove = (event: TouchEvent) => {
            if (swipe === undefined) return false;
            if (event.touches.length !== 1 || !event.cancelable) {
              swipe = undefined;
              return false;
            }
            if (swipe.handled) {
              event.preventDefault();
              return true;
            }
            const touch = event.touches[0]!;
            const dx = touch.clientX - swipe.x;
            const dy = Math.abs(touch.clientY - swipe.y);
            if (
              view.state.doc !== swipe.doc ||
              event.timeStamp - swipe.time > 500 ||
              (dy > 12 && dy * 1.5 >= Math.abs(dx))
            ) {
              swipe = undefined;
              return false;
            }
            if (Math.abs(dx) < 12) return false;
            // Claim horizontal movement before the browser commits to scrolling.
            event.preventDefault();
            if (Math.abs(dx) < 40) return true;
            swipe.handled = true;
            const chain = this.editor.chain().setTextSelection(swipe.selection);
            if (dx > 0) chain.sinkListItem(swipe.name).run();
            else chain.liftListItem(swipe.name).run();
            return true;
          };
          // ProseMirror registers touchmove as passive, so its DOM-event hook
          // cannot stop native scrolling after a horizontal swipe is claimed.
          view.dom.addEventListener("touchmove", touchmove, { passive: false });
          return {
            destroy: () => view.dom.removeEventListener("touchmove", touchmove),
          };
        },
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
