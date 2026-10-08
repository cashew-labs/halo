import { useState } from "react";
import type { Editor } from "@tiptap/core";
import { backgroundColor, colors, flex, radius, shadow, spacing } from "maui";
import { style, useStyles } from "purse-styles";

export type ReferenceTarget =
  | { kind: "file"; path: string }
  | { kind: "session"; sessionId: string; title: string };

type Query = { query: string; from: number; to: number };

export function useReferencePicker({
  targets,
  onSelect,
  placement = "above",
}: {
  targets: ReferenceTarget[] | undefined;
  onSelect: (target: ReferenceTarget, query: Query) => void;
  placement?: "above" | "below" | "cursor";
}) {
  const resultsClassName = useStyles(resultsClass);
  const placementClassName = useStyles(
    placement === "above"
      ? aboveClass
      : placement === "below"
        ? belowClass
        : undefined,
  );
  const resultClassName = useStyles(resultClass);
  const detailClassName = useStyles(detailClass);
  const [query, setQuery] = useState<Query>();
  const [anchor, setAnchor] = useState<{ left: number; top: number }>();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const matches =
    query === undefined
      ? []
      : (targets ?? [])
          .filter((target) =>
            (target.kind === "file" ? target.path : target.title)
              .toLowerCase()
              .includes(query.query.toLowerCase()),
          )
          .slice(0, 8);

  function select(target: ReferenceTarget) {
    if (query === undefined) return;
    setQuery(undefined);
    onSelect(target, query);
  }

  return {
    onSelectionUpdate(editor: Editor) {
      const next = activeReferenceQuery(editor);
      setQuery(next);
      if (next !== undefined && placement === "cursor") {
        const caret = editor.view.coordsAtPos(next.to);
        setAnchor({
          left: Math.max(8, Math.min(caret.left, window.innerWidth - 328)),
          top:
            caret.bottom + 248 < window.innerHeight
              ? caret.bottom + 8
              : Math.max(8, caret.top - 248),
        });
      }
      setSelectedIndex(0);
    },
    onKeyDown(event: KeyboardEvent) {
      if (query === undefined || event.metaKey || event.ctrlKey) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        setQuery(undefined);
        return true;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((index) =>
          matches.length === 0
            ? 0
            : (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) %
              matches.length,
        );
        return true;
      }
      if (event.key === "Enter" && matches[selectedIndex] !== undefined) {
        event.preventDefault();
        select(matches[selectedIndex]);
        return true;
      }
      return false;
    },
    menu:
      query === undefined ? undefined : (
        <div
          className={`${resultsClassName} ${placementClassName}`}
          style={
            placement === "cursor" && anchor !== undefined
              ? {
                  position: "fixed",
                  left: anchor.left,
                  top: anchor.top,
                  right: "auto",
                  width: 320,
                }
              : undefined
          }
          role="listbox"
          aria-label="Reference a file or session"
        >
          {matches.length === 0 ? (
            <div className={resultClassName}>
              {targets === undefined
                ? "Loading references…"
                : "No matching references"}
            </div>
          ) : (
            matches.map((target, index) => (
              <div
                key={
                  target.kind === "file"
                    ? `file:${target.path}`
                    : `session:${target.sessionId}`
                }
                role="option"
                aria-selected={index === selectedIndex}
                className={resultClassName}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(target)}
              >
                <span>
                  {target.kind === "file"
                    ? target.path.split("/").at(-1)
                    : target.title}
                </span>
                <span className={detailClassName}>
                  {target.kind === "file" ? target.path : "Session"}
                </span>
              </div>
            ))
          )}
        </div>
      ),
  };
}

export function referenceHref(target: ReferenceTarget) {
  return target.kind === "file"
    ? `/files/${target.path.split("/").map(encodeURIComponent).join("/")}`
    : `/sessions/${encodeURIComponent(target.sessionId)}`;
}

function activeReferenceQuery(editor: Editor) {
  const selection = editor.state.selection;
  if (!selection.empty) return undefined;
  const before = editor.state.doc.textBetween(
    Math.max(0, selection.from - 200),
    selection.from,
    "\n",
  );
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (match === null) return undefined;
  return {
    query: match[1] ?? "",
    from: selection.from - (match[1]?.length ?? 0) - 1,
    to: selection.from,
  };
}

const resultsClass = style(radius.md, shadow.medium, {
  position: "absolute",
  left: 0,
  right: 0,
  zIndex: 5,
  maxHeight: "240px",
  overflowY: "auto",
  backgroundColor: backgroundColor.element,
  padding: spacing.value(2),
});
const aboveClass = style({ bottom: "calc(100% + 8px)" });
const belowClass = style({ top: "calc(100% + 8px)" });
const resultClass = style(
  flex({ direction: "column", gap: 1 }),
  spacing.padding({ x: 3, y: 2 }),
  radius.sm,
  {
    cursor: "pointer",
    color: colors.gray[12],
    "&:hover, &[aria-selected='true']": {
      backgroundColor: backgroundColor.elementHover,
    },
  },
);
const detailClass = style({
  color: colors.gray[10],
  fontSize: "0.75em",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
