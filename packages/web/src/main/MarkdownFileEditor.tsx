import { EditorContent } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { colors, flex } from "maui";
import { style, useStyles } from "purse-styles";
import { useAutosaveFile } from "./useAutosaveFile.js";
import { useMarkdownEditor } from "./useMarkdownEditor.js";
import { markdownImage } from "./markdownImage.js";
import { useApi } from "../api/ApiProvider.js";

export function MarkdownFileEditor({
  path,
  loaded,
}: {
  path: string;
  loaded: string;
}) {
  const autosave = useAutosaveFile({ path, loaded });
  const api = useApi();
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);
  const [error, setError] = useState<string>();
  /* oxlint-disable react/refs -- The factory stores the ref; only later plugin event handlers read its client. */
  const extensions = useMemo(
    () => [
      markdownImage({
        client: apiRef,
        documentPath: path,
        onError: setError,
      }),
    ],
    [path, apiRef],
  );
  /* oxlint-enable react/refs */
  const className = useStyles(editorClass);
  const editor = useMarkdownEditor({
    content: loaded,
    onChange: autosave.onChange,
    "aria-label": path,
    size: "sm",
    extensions,
  });
  return (
    <>
      {error !== undefined && <p role="alert">{error}</p>}
      <EditorContent editor={editor} className={className} />
    </>
  );
}

const editorClass = style(flex({ direction: "column" }), {
  minWidth: 0,
  width: "100%",
  minHeight: "100%",
  "& .ProseMirror img": { maxWidth: "100%", height: "auto" },
  "& .ProseMirror img.ProseMirror-selectednode": {
    borderRadius: "8px",
    outline: `2px solid ${colors.gray[11]}`,
    outlineOffset: "2px",
  },
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
