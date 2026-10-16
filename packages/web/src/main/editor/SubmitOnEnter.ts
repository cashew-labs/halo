import { Extension } from "@tiptap/core";

export const SubmitOnEnter = Extension.create<{ onSubmit: () => void }>({
  name: "submitOnEnter",
  // Run before ListItem's Enter and HardBreak's Shift-Enter and Mod-Enter.
  priority: 1000,

  addOptions() {
    return { onSubmit: () => {} };
  },

  addKeyboardShortcuts() {
    const submit = () => {
      this.options.onSubmit();
      return true;
    };
    return {
      Enter: submit,
      "Mod-Enter": submit,
      // Tiptap's default Enter chain, plus the Enter behavior that list items,
      // CodeBlock's triple-Enter exit, and its fence input rule would add.
      "Shift-Enter": () =>
        this.editor.commands.first(({ commands, state }) => {
          const { $from } = state.selection;
          const fence = /^(?:```|~~~)([a-z]+)?$/.exec(
            $from.parent.textBetween(0, $from.parentOffset),
          );
          return [
            () =>
              $from.parent.type.name === "codeBlock" &&
              state.selection.empty &&
              $from.parentOffset === $from.parent.content.size &&
              $from.parent.textContent.endsWith("\n\n") &&
              commands.deleteRange({ from: $from.pos - 2, to: $from.pos }) &&
              commands.exitCode(),
            () => commands.newlineInCode(),
            () =>
              fence !== null &&
              commands.deleteRange({ from: $from.start(), to: $from.pos }) &&
              commands.setCodeBlock({ language: fence[1] }),
            () => commands.splitListItem("listItem"),
            () => commands.createParagraphNear(),
            () => commands.liftEmptyBlock(),
            () => commands.splitBlock(),
          ];
        }),
    };
  },
});
