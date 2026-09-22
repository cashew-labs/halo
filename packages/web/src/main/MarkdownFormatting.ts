import { Extension } from "@tiptap/core";

export const MarkdownFormatting = Extension.create({
  name: "markdownFormatting",

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { empty, $from } = this.editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        if ($from.parent.type.name !== "heading") return false;
        // Remove the heading before ProseMirror tries to join the previous block.
        return this.editor.commands.first(({ commands }) => [
          () => commands.undoInputRule(),
          () => commands.setParagraph(),
        ]);
      },
      "Mod-\\": () =>
        this.editor
          .chain()
          .unsetAllMarks()
          .clearNodes()
          .command(({ tr }) => {
            // unsetAllMarks only changes selected text, not future typing marks.
            tr.setStoredMarks([]);
            return true;
          })
          .run(),
    };
  },
});
