import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  Selection,
  SelectionRange,
  TextSelection,
  type EditorState,
} from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Adapted from Whim's BlockSelection and blockApi, using Halo's Tiptap schema.
type Block = { from: number; to: number; node: ProseMirrorNode };
const isList = (node: ProseMirrorNode) =>
  ["bulletList", "orderedList", "taskList"].includes(node.type.name);
const isItem = (node: ProseMirrorNode) =>
  ["listItem", "taskItem"].includes(node.type.name);

function blocksIn(doc: ProseMirrorNode) {
  const blocks: Block[] = [];
  doc.descendants((node, from, parent, index) => {
    if (!node.isBlock || isList(node) || node.type.name === "blockquote")
      return;
    // The first paragraph and its list item are one visual block.
    if (parent !== null && isItem(parent) && index === 0) return false;
    blocks.push({ from, to: from + node.nodeSize, node });
    return !node.isTextblock;
  });
  return blocks;
}

function currentBlock(state: EditorState, position = state.selection.from) {
  const blocks = blocksIn(state.doc);
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!;
    if (block.from <= position && block.to > position) return block;
  }
  return undefined;
}

class BlockSelection extends Selection {
  constructor(
    readonly anchorBlock: number,
    readonly headBlock: number,
    doc: ProseMirrorNode,
  ) {
    const blocks = blocksIn(doc);
    const start = Math.min(anchorBlock, headBlock);
    const end = Math.max(anchorBlock, headBlock);
    // Selecting a container already includes its descendants.
    const selected = blocks.filter(
      (block) => block.from >= start && block.from <= end,
    );
    const ranges = selected
      .filter(
        (block, index) =>
          !selected.slice(0, index).some((parent) => parent.to >= block.to),
      )
      .map(
        (block) =>
          new SelectionRange(doc.resolve(block.from), doc.resolve(block.to)),
      );
    super(doc.resolve(anchorBlock), doc.resolve(headBlock), ranges);
  }

  visible = false;

  map(doc: ProseMirrorNode, mapping: Mappable): Selection {
    const anchor = mapping.mapResult(this.anchorBlock, 1);
    const head = mapping.mapResult(this.headBlock, 1);
    if (
      anchor.deleted ||
      head.deleted ||
      !isSelectableBlock(doc, anchor.pos) ||
      !isSelectableBlock(doc, head.pos)
    ) {
      return Selection.near(
        doc.resolve(Math.min(anchor.pos, doc.content.size)),
      );
    }
    return new BlockSelection(anchor.pos, head.pos, doc);
  }

  eq(other: Selection) {
    return (
      other instanceof BlockSelection &&
      other.anchorBlock === this.anchorBlock &&
      other.headBlock === this.headBlock
    );
  }

  toJSON() {
    return {
      type: "haloBlock",
      anchor: this.anchorBlock,
      head: this.headBlock,
    };
  }

  static fromJSON(
    doc: ProseMirrorNode,
    value: { anchor: number; head: number },
  ) {
    if (
      !isSelectableBlock(doc, value.anchor) ||
      !isSelectableBlock(doc, value.head)
    ) {
      return Selection.near(
        doc.resolve(Math.min(value.anchor, doc.content.size)),
      );
    }
    return new BlockSelection(value.anchor, value.head, doc);
  }

  getBookmark() {
    return new BlockBookmark(this.anchorBlock, this.headBlock);
  }
}

class BlockBookmark {
  constructor(
    private readonly anchor: number,
    private readonly head: number,
  ) {}
  map(mapping: Mappable) {
    return new BlockBookmark(mapping.map(this.anchor), mapping.map(this.head));
  }
  resolve(doc: ProseMirrorNode) {
    return BlockSelection.fromJSON(doc, {
      anchor: this.anchor,
      head: this.head,
    });
  }
}

function isSelectableBlock(doc: ProseMirrorNode, position: number) {
  return blocksIn(doc).some((block) => block.from === position);
}

Selection.jsonID("haloBlock", BlockSelection);

function navigateBlocks(
  state: EditorState,
  direction: number,
  extend: boolean,
) {
  const selection = state.selection;
  if (!(selection instanceof BlockSelection)) return undefined;
  const blocks = blocksIn(state.doc);
  const index = blocks.findIndex((block) => block.from === selection.headBlock);
  const next = blocks[index + direction];
  if (next === undefined) return selection;
  return new BlockSelection(
    extend ? selection.anchorBlock : next.from,
    next.from,
    state.doc,
  );
}

function moveBlock(state: EditorState, direction: number) {
  const block = currentBlock(state);
  if (block === undefined) return undefined;
  // Whim's move command operates on one block. Keep a multi-block selection intact.
  if (
    state.selection instanceof BlockSelection &&
    state.selection.ranges.length > 1
  )
    return undefined;
  const slots: { position: number; content: Fragment; offset: number }[] = [];
  const collect = (parent: ProseMirrorNode, start: number) => {
    if (parent.isTextblock || parent.isLeaf) return;
    let position = start;
    for (let index = 0; index <= parent.childCount; index++) {
      if (
        !(position >= block.from && position <= block.to) &&
        !(isItem(parent) && index === 0)
      ) {
        const content =
          isItem(block.node) && !isList(parent)
            ? block.node.content
            : Fragment.from(block.node);
        const first = content.firstChild!;
        const wrapping = parent.contentMatchAt(index).findWrapping(first.type);
        const fitted = wrapping?.reduceRight(
          (fragment, type) => Fragment.from(type.create(undefined, fragment)),
          content,
        );
        if (fitted !== undefined && parent.canReplace(index, index, fitted)) {
          slots.push({
            position,
            content: fitted,
            offset:
              (isItem(block.node) && !isList(parent) ? -1 : 0) +
              wrapping!.length,
          });
        }
      }
      if (index < parent.childCount) position += parent.child(index).nodeSize;
    }
  };
  collect(state.doc, 0);
  state.doc.descendants((node, position) => {
    if (position >= block.from && position < block.to) return false;
    collect(node, position + 1);
  });
  const target = slots.reduce<(typeof slots)[number] | undefined>(
    (nearest, slot) => {
      const eligible =
        direction < 0 ? slot.position < block.from : slot.position > block.to;
      if (!eligible) return nearest;
      if (
        nearest === undefined ||
        direction * (slot.position - nearest.position) < 0
      )
        return slot;
      return nearest;
    },
    undefined,
  );
  if (target === undefined) return undefined;
  const tr = state.tr;
  tr.deleteRange(block.from, block.to);
  const position = tr.mapping.map(target.position, direction);
  tr.insert(position, target.content);
  if (state.selection instanceof BlockSelection) {
    const moved = blocksIn(tr.doc).find(
      (candidate) =>
        candidate.from >= position &&
        candidate.from < position + target.content.size,
    );
    if (moved !== undefined)
      tr.setSelection(new BlockSelection(moved.from, moved.from, tr.doc));
  } else {
    const offset = state.selection.from - block.from + target.offset;
    tr.setSelection(
      TextSelection.near(
        tr.doc.resolve(
          position + Math.max(0, Math.min(offset, target.content.size)),
        ),
      ),
    );
  }
  return closeHistory(tr).scrollIntoView();
}

export const BlockEditing = Extension.create({
  name: "blockEditing",
  priority: 1100,
  addKeyboardShortcuts() {
    const navigate = (direction: number, extend: boolean) => () => {
      const selection = navigateBlocks(this.editor.state, direction, extend);
      if (selection === undefined) return false;
      this.editor.view.dispatch(
        this.editor.state.tr.setSelection(selection).scrollIntoView(),
      );
      return true;
    };
    const edit = () => {
      const { state, view } = this.editor;
      if (!(state.selection instanceof BlockSelection)) return false;
      view.dispatch(
        state.tr
          .setSelection(
            TextSelection.near(
              state.doc.resolve(state.selection.headBlock + 1),
            ),
          )
          .scrollIntoView(),
      );
      return true;
    };
    const move = (direction: number) => () => {
      const tr = moveBlock(this.editor.state, direction);
      if (tr === undefined)
        return this.editor.state.selection instanceof BlockSelection;
      this.editor.view.dispatch(tr);
      return true;
    };
    return {
      Escape: () => {
        if (edit()) return true;
        const { state, view } = this.editor;
        const first = currentBlock(state);
        const last = currentBlock(
          state,
          state.selection.empty ? state.selection.to : state.selection.to - 1,
        );
        if (first === undefined || last === undefined) return false;
        view.dispatch(
          closeHistory(
            state.tr.setSelection(
              new BlockSelection(first.from, last.from, state.doc),
            ),
          ),
        );
        return true;
      },
      Enter: edit,
      ArrowUp: navigate(-1, false),
      ArrowDown: navigate(1, false),
      "Shift-ArrowUp": navigate(-1, true),
      "Shift-ArrowDown": navigate(1, true),
      ArrowLeft: edit,
      ArrowRight: edit,
      "Alt-ArrowUp": move(-1),
      "Alt-ArrowDown": move(1),
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            if (!(state.selection instanceof BlockSelection))
              return DecorationSet.empty;
            return DecorationSet.create(
              state.doc,
              state.selection.ranges.map((range) =>
                Decoration.node(range.$from.pos, range.$to.pos, {
                  class: "halo-selected-block",
                }),
              ),
            );
          },
          handleClickOn(view, _position, node, nodePosition, event, direct) {
            if (
              !direct ||
              !(event.metaKey || event.ctrlKey) ||
              node.isInline ||
              !NodeSelection.isSelectable(node)
            )
              return false;
            if (
              event.target instanceof Element &&
              event.target.closest("a[href]")
            )
              return false;
            const block = currentBlock(view.state, nodePosition + 1);
            if (block === undefined) return false;
            view.dispatch(
              view.state.tr.setSelection(
                new BlockSelection(block.from, block.from, view.state.doc),
              ),
            );
            return true;
          },
        },
      }),
    ];
  },
});
