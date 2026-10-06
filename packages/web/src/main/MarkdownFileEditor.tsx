import { TaskList } from "@tiptap/extension-list";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  backgroundColor,
  colors,
  flex,
  radius,
  shadow,
  text as textStyle,
} from "maui";
import { Editor } from "maui/editor";
import { style, useStyles } from "purse-styles";
import { useAutosaveFile } from "./useAutosaveFile.js";
import { useMarkdownEditor } from "./useMarkdownEditor.js";
import { markdownImage } from "./markdownImage.js";
import { BlockEditing } from "./BlockEditing.js";
import { MarkdownTaskItem } from "./MarkdownTaskItem.js";
import {
  MarkdownFindHighlight,
  setMarkdownFindHighlight,
} from "./MarkdownFindHighlight.js";
import {
  useApi,
  useSessionsQuery,
  useWorkspacePathsQuery,
  useWorkspaceQuery,
} from "../api/ApiProvider.js";
import { useTabFindSource } from "../panes/TabFind.js";
import { useIsActiveTab } from "../panes/WorkspacePanesProvider.js";
import { observeFileSelection } from "./chatReferences.js";
import {
  referenceHref,
  useReferencePicker,
  type ReferenceTarget,
} from "./ReferencePicker.js";

export function MarkdownFileEditor({
  path,
  loaded,
}: {
  path: string;
  loaded: string;
}) {
  const autosave = useAutosaveFile({ path, loaded });
  const isActiveTab = useIsActiveTab();
  const api = useApi();
  const workspace = useWorkspaceQuery().data;
  const paths = useWorkspacePathsQuery(workspace).data;
  const sessions = useSessionsQuery(workspace).data ?? [];
  const targets: ReferenceTarget[] = [
    ...(paths ?? [])
      .filter((candidate) => !candidate.endsWith("/"))
      .map((candidate) => ({ kind: "file" as const, path: candidate })),
    ...sessions.map((session) => ({
      kind: "session" as const,
      sessionId: session.sessionId,
      title: session.title ?? session.sessionId,
    })),
  ];
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);
  const [error, setError] = useState<string>();
  const [, forceUpdate] = useState(0);
  const copyMenuClassName = useStyles(copyMenuStyle);
  /* oxlint-disable react/refs -- The factory stores the ref; only later plugin event handlers read its client. */
  const extensions = useMemo(
    () => [
      BlockEditing,
      TaskList,
      MarkdownTaskItem.configure({ nested: true }),
      markdownImage({
        client: apiRef,
        documentPath: path,
        copyMenuClassName,
        onError: setError,
      }),
      MarkdownFindHighlight,
    ],
    [path, apiRef, copyMenuClassName],
  );
  /* oxlint-enable react/refs */
  const className = useStyles(editorClass);
  const shellClassName = useStyles(editorShellClass);
  const picker = useReferencePicker({
    targets,
    placement: "cursor",
    onSelect: (target, query) => {
      if (editor === null) return;
      editor
        .chain()
        .focus()
        .insertContentAt({ from: query.from, to: query.to }, [
          {
            type: "text",
            text: `@${target.kind === "file" ? target.path.split("/").at(-1) : target.title}`,
            marks: [{ type: "link", attrs: { href: referenceHref(target) } }],
          },
          { type: "text", text: " " },
        ])
        .run();
    },
  });
  const editor = useMarkdownEditor({
    content: autosave.loaded,
    onChange: (content) => {
      autosave.onChange(content);
      forceUpdate((current) => current + 1);
    },
    "aria-label": path,
    extensions,
    onSelectionUpdate: picker.onSelectionUpdate,
    onKeyDown: picker.onKeyDown,
  });
  const doc = editor?.state.doc;
  useEffect(() => {
    if (!isActiveTab || editor === null) return;
    return observeFileSelection(() => {
      const nativeSelection = document.getSelection();
      if (
        nativeSelection !== null &&
        !nativeSelection.isCollapsed &&
        editor.view.dom.contains(nativeSelection.anchorNode) &&
        editor.view.dom.contains(nativeSelection.focusNode)
      ) {
        const selectedText = nativeSelection.toString().trim();
        if (selectedText) return { path, text: selectedText };
      }
      const selection = editor.state.selection;
      if (selection.empty) return undefined;
      const text = editor.state.doc
        .textBetween(selection.from, selection.to, "\n")
        .trim();
      return text ? { path, text } : undefined;
    });
  }, [editor, isActiveTab, path]);
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
      <div className={shellClassName}>
        {picker.menu}
        <Editor editor={editor} size="sm" className={className} />
      </div>
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
  '& .ProseMirror ul[data-type="taskList"]': {
    paddingInlineStart: 0,
  },
  '& .ProseMirror ul[data-type="taskList"] > li': {
    display: "flex",
    alignItems: "baseline",
    gap: "0.5em",
  },
  '& .ProseMirror ul[data-type="taskList"] > li::before': {
    content: "none",
  },
  '& .ProseMirror ul[data-type="taskList"] > li > div': {
    minWidth: 0,
  },
  "& .ProseMirror p.is-editor-empty:first-child::before": {
    color: colors.gray[9],
    content: "attr(data-placeholder)",
    float: "left",
    height: 0,
    pointerEvents: "none",
  },
});

const copyMenuStyle = style(
  radius.sm,
  shadow.medium,
  textStyle({ size: "sm" }),
  {
    position: "fixed",
    zIndex: 100,
    display: "flex",
    alignItems: "center",
    minHeight: "28px",
    paddingInline: "10px",
    border: 0,
    color: colors.gray[12],
    backgroundColor: backgroundColor.element,
    cursor: "pointer",
    "&:hover": { backgroundColor: backgroundColor.elementHover },
  },
);

const editorShellClass = style({ position: "relative", minHeight: "100%" });
