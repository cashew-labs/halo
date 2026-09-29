import { EditorContent } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { colors, flex } from "maui";
import { style, useStyles } from "purse-styles";
import { useAutosaveFile } from "./useAutosaveFile.js";
import { useMarkdownEditor } from "./useMarkdownEditor.js";
import { markdownImage } from "./markdownImage.js";
import {
  MarkdownFindHighlight,
  setMarkdownFindHighlight,
} from "./MarkdownFindHighlight.js";
import { useApi } from "../api/ApiProvider.js";
import { useTabFindSource } from "../panes/TabFind.js";

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
  const [, forceUpdate] = useState(0);
  /* oxlint-disable react/refs -- The factory stores the ref; only later plugin event handlers read its client. */
  const extensions = useMemo(
    () => [
      markdownImage({
        client: apiRef,
        documentPath: path,
        onError: setError,
      }),
      MarkdownFindHighlight,
    ],
    [path, apiRef],
  );
  /* oxlint-enable react/refs */
  const className = useStyles(editorClass);
  const editor = useMarkdownEditor({
    content: autosave.loaded,
    onChange: (content) => {
      autosave.onChange(content);
      forceUpdate((current) => current + 1);
    },
    "aria-label": path,
    size: "sm",
    extensions,
  });
  const doc = editor?.state.doc;
  const findSource = useMemo(() => {
    if (editor === null || doc === undefined) return undefined;
    const blocks: {
      id: string;
      text: string;
      spans: { start: number; end: number; position: number }[];
    }[] = [];
    doc.descendants((node, position) => {
      if (!node.isTextblock) return;
      const parts: string[] = [];
      const spans: { start: number; end: number; position: number }[] = [];
      let length = 0;
      node.descendants((child, offset) => {
        if (!child.isText || child.text === undefined) return;
        parts.push(child.text);
        spans.push({
          start: length,
          end: length + child.text.length,
          position: position + 1 + offset,
        });
        length += child.text.length;
      });
      if (length > 0)
        blocks.push({ id: String(position), text: parts.join(""), spans });
      return false;
    });
    const locate = (segmentId: string, start: number, end: number) => {
      const block = blocks.find((item) => item.id === segmentId);
      if (block === undefined) return;
      const first = block.spans.find(
        (span) => start >= span.start && start < span.end,
      );
      const last = block.spans.find(
        (span) => end > span.start && end <= span.end,
      );
      if (first === undefined || last === undefined) return;
      return {
        from: first.position + start - first.start,
        to: last.position + end - last.start,
      };
    };
    return {
      segments: blocks,
      select: (segmentId: string, start: number, end: number) => {
        const range = locate(segmentId, start, end);
        if (range === undefined) return;
        editor.commands.setTextSelection(range);
        editor.view.dom
          .querySelector(".halo-find-active-match")
          ?.scrollIntoView({ block: "center", inline: "nearest" });
      },
      highlight: (
        match: { segmentId: string; start: number; end: number } | undefined,
      ) => {
        const range =
          match === undefined
            ? undefined
            : locate(match.segmentId, match.start, match.end);
        setMarkdownFindHighlight(editor, range);
      },
    };
  }, [editor, doc]);
  useTabFindSource(findSource);
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
  "& .halo-find-active-match": {
    backgroundColor: colors.amber[5],
    borderRadius: 2,
  },
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
