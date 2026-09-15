import { useState } from "react";
import { backgroundColor, colors, monoFontFamily, text } from "maui";
import { style, useStyles } from "purse-styles";
import { useAutosaveFile } from "./useAutosaveFile.js";

export function TextFileEditor({
  path,
  loaded,
}: {
  path: string;
  loaded: string;
}) {
  const [content, setContent] = useState(loaded);
  const autosave = useAutosaveFile({ path, loaded });
  const editor = useStyles(editorStyle);
  return (
    <textarea
      aria-label={path}
      className={editor}
      value={content}
      spellCheck={false}
      onChange={(event) => {
        setContent(event.target.value);
        autosave.onChange(event.target.value);
      }}
    />
  );
}

const editorStyle = style(text({ size: "sm" }), {
  width: "100%",
  height: "100%",
  minHeight: "200px",
  boxSizing: "border-box",
  resize: "none",
  border: 0,
  outline: "none",
  padding: 0,
  fontFamily: monoFontFamily,
  color: colors.gray[12],
  backgroundColor: backgroundColor.app,
  lineHeight: 1.6,
});
