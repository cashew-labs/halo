import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { backgroundColor, colors, monoFontFamily, text } from "maui";
import { style, useStyles } from "purse-styles";
import { useAutosaveFile } from "./useAutosaveFile.js";
import { useTabFindSource } from "../panes/TabFind.js";

export function TextFileEditor({
  path,
  loaded,
}: {
  path: string;
  loaded: string;
}) {
  const [content, setContent] = useState(loaded);
  const [activeMatch, setActiveMatch] = useState<{
    start: number;
    end: number;
  }>();
  const [revealRequest, setRevealRequest] = useState<{
    start: number;
    end: number;
  }>();
  const input = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const activeMark = useRef<HTMLElement>(null);
  const lastRevealed = useRef<typeof revealRequest>(undefined);
  const findSource = useMemo(
    () => ({
      segments: [{ id: path, text: content }],
      select: (_segmentId: string, start: number, end: number) => {
        input.current?.setSelectionRange(start, end);
        setRevealRequest({ start, end });
      },
      highlight: (match: { start: number; end: number } | undefined) => {
        setActiveMatch(
          match === undefined
            ? undefined
            : { start: match.start, end: match.end },
        );
      },
    }),
    [path, content],
  );
  useTabFindSource(findSource);
  useLayoutEffect(() => {
    if (activeMatch === undefined) return;
    const editor = input.current;
    const overlay = mirror.current;
    const mark = activeMark.current;
    if (editor === null || overlay === null || mark === null) return;
    overlay.scrollTop = editor.scrollTop;
    overlay.scrollLeft = editor.scrollLeft;
    if (
      revealRequest === undefined ||
      lastRevealed.current === revealRequest ||
      activeMatch.start !== revealRequest.start ||
      activeMatch.end !== revealRequest.end
    )
      return;
    lastRevealed.current = revealRequest;
    const viewport = overlay.getBoundingClientRect();
    const match = mark.getBoundingClientRect();
    if (match.top < viewport.top || match.bottom > viewport.bottom) {
      editor.scrollTop +=
        match.top - viewport.top - (viewport.height - match.height) / 2;
      overlay.scrollTop = editor.scrollTop;
    }
    if (match.left < viewport.left || match.right > viewport.right) {
      editor.scrollLeft +=
        match.left - viewport.left - (viewport.width - match.width) / 2;
      overlay.scrollLeft = editor.scrollLeft;
    }
  }, [activeMatch, revealRequest]);
  const autosave = useAutosaveFile({ path, loaded });
  const container = useStyles(containerStyle);
  const mirrored = useStyles(mirrorStyle);
  const highlight = useStyles(highlightStyle);
  const editor = useStyles(editorStyle);
  const transparentEditor = useStyles(editorStyle, transparentEditorStyle);
  return (
    <div className={container}>
      {activeMatch !== undefined && (
        <div ref={mirror} className={mirrored} aria-hidden="true">
          {content.slice(0, activeMatch.start)}
          <mark ref={activeMark} className={highlight}>
            {content.slice(activeMatch.start, activeMatch.end)}
          </mark>
          {content.slice(activeMatch.end)}
        </div>
      )}
      <textarea
        ref={input}
        aria-label={path}
        className={activeMatch === undefined ? editor : transparentEditor}
        value={content}
        spellCheck={false}
        onScroll={(event) => {
          if (mirror.current === null) return;
          mirror.current.scrollTop = event.currentTarget.scrollTop;
          mirror.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        onChange={(event) => {
          setContent(event.target.value);
          autosave.onChange(event.target.value);
        }}
      />
    </div>
  );
}

const containerStyle = style({
  position: "relative",
  width: "100%",
  height: "100%",
  minHeight: "200px",
});

const mirrorStyle = style(text({ size: "sm" }), {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
  pointerEvents: "none",
  fontFamily: monoFontFamily,
  color: colors.gray[12],
  lineHeight: 1.6,
});

const highlightStyle = style({
  backgroundColor: colors.amber[5],
  color: colors.gray[12],
  borderRadius: 2,
});

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

const transparentEditorStyle = style({
  color: "transparent",
  backgroundColor: "transparent",
  caretColor: colors.gray[12],
});
