import { EditorContent } from "@tiptap/react";
import { colors, flex } from "maui";
import { style, useStyles } from "purse-styles";
import { useAutosaveFile } from "./useAutosaveFile.js";
import { useMarkdownEditor } from "./useMarkdownEditor.js";

export function MarkdownFileEditor({
  path,
  loaded,
}: {
  path: string;
  loaded: string;
}) {
  const autosave = useAutosaveFile({ path, loaded });
  const className = useStyles(editorClass);
  const editor = useMarkdownEditor({
    content: loaded,
    onChange: autosave.onChange,
    "aria-label": path,
    size: "sm",
  });
  return <EditorContent editor={editor} className={className} />;
}

const editorClass = style(flex({ direction: "column" }), {
  minWidth: 0,
  width: "100%",
  minHeight: "100%",
  "& .ProseMirror": {
    flex: "1 0 auto",
    outline: "none",
    minHeight: "2.75em",
  },
  "& .ProseMirror p.is-editor-empty:first-child::before": {
    color: colors.gray[9],
    content: "attr(data-placeholder)",
    float: "left",
    height: 0,
    pointerEvents: "none",
  },
});
