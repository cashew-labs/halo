import type React from "react";
import { useState } from "react";
import type { Editor as TiptapEditor } from "@tiptap/core";
import {
  backgroundColor,
  colors,
  flex,
  focusRing,
  proseContainerStyle,
  radius,
  shadow,
  shadowVars,
  spacing,
  type ProseSize,
} from "maui";
import { Editor as MauiEditor } from "maui/editor";
import { style, useStyles } from "purse-styles";
import { proseInlineCode } from "./proseInlineCode.ts";
import { useMarkdownEditor } from "../useMarkdownEditor.js";

type EditorProps = {
  /** Initial markdown content. Updates are applied when this value changes. */
  content?: string;
  autoFocus?: boolean;
  /** Called with the current markdown whenever the document changes. */
  onChange?: (markdown: string) => void;
  placeholder?: string;
  size?: ProseSize;
  editable?: boolean;
  className?: string;
  "aria-label"?: string;
  onSubmit?: () => void;
  /** Optional actions rendered inside the editor shell (e.g. Send). */
  actions?: React.ReactNode;
  header?: React.ReactNode;
  error?: React.ReactNode;
  referencePaths?: string[];
  onAddReference?: (path: string) => void;
  referencePlacement?: "above" | "below";
};

/**
 * TipTap markdown editor with CommonMark shortcuts (`#`, `**`, `-`, `>`, …)
 * and Maui prose type styles on the ProseMirror surface.
 */
export function Editor({
  content = "",
  autoFocus = false,
  onChange,
  placeholder = "Write a message…",
  size = "md",
  editable = true,
  className,
  "aria-label": ariaLabel = "Message editor",
  onSubmit,
  actions,
  header,
  error,
  referencePaths,
  onAddReference,
  referencePlacement = "above",
}: EditorProps) {
  const shellClassName = useStyles(editorShellClass);
  const actionsClassName = useStyles(editorActionsClass);
  const inlineCodeClassName = useStyles(proseInlineCode);
  const resultsClassName = useStyles(referenceResultsClass);
  const resultsPlacementClassName = useStyles(
    referencePlacement === "above"
      ? referenceResultsAboveClass
      : referenceResultsBelowClass,
  );
  const resultClassName = useStyles(referenceResultClass);
  const resultPathClassName = useStyles(referencePathClass);
  const [referenceQuery, setReferenceQuery] = useState<{
    query: string;
    from: number;
    to: number;
  }>();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const matches =
    referenceQuery === undefined
      ? []
      : (referencePaths ?? [])
          .filter((path) =>
            path.toLowerCase().includes(referenceQuery.query.toLowerCase()),
          )
          .slice(0, 8);

  function selectReference(path: string) {
    if (editor === null || referenceQuery === undefined) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: referenceQuery.from, to: referenceQuery.to })
      .run();
    setReferenceQuery(undefined);
    onAddReference?.(path);
  }
  const editor = useMarkdownEditor({
    content,
    autoFocus,
    onChange,
    placeholder,
    editable,
    "aria-label": ariaLabel,
    onSubmit,
    onSelectionUpdate: (current) => {
      const next =
        onAddReference === undefined
          ? undefined
          : activeReferenceQuery(current);
      setReferenceQuery(next);
      setSelectedIndex(0);
    },
    onKeyDown: (event) => {
      if (referenceQuery === undefined || event.metaKey || event.ctrlKey)
        return false;
      if (event.key === "Escape") {
        event.preventDefault();
        setReferenceQuery(undefined);
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
        selectReference(matches[selectedIndex]);
        return true;
      }
      return false;
    },
    inlineCodeClassName,
  });

  return (
    <div
      className={joinClassNames(shellClassName, className)}
      onClick={(event) => {
        const editorElement = editor?.view.dom;
        if (
          event.target instanceof Node &&
          editorElement?.contains(event.target)
        ) {
          return;
        }
        editor?.commands.focus();
      }}
    >
      {referenceQuery === undefined ? undefined : (
        <div
          className={`${resultsClassName} ${resultsPlacementClassName}`}
          role="listbox"
          aria-label="Reference a file"
        >
          {matches.length === 0 ? (
            <div className={resultClassName}>
              {referencePaths === undefined
                ? "Loading files…"
                : "No matching files"}
            </div>
          ) : (
            matches.map((path, index) => (
              <div
                key={path}
                role="option"
                aria-selected={index === selectedIndex}
                className={resultClassName}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectReference(path)}
              >
                <span>{path.split("/").at(-1)}</span>
                {path.includes("/") ? (
                  <span className={resultPathClassName}>{path}</span>
                ) : undefined}
              </div>
            ))
          )}
        </div>
      )}
      {header}
      <MauiEditor editor={editor} size={size} />
      {error}
      {actions ? <div className={actionsClassName}>{actions}</div> : undefined}
    </div>
  );
}

const editorShellClass = style(
  proseContainerStyle,
  radius.lg,
  shadow.subtle,
  spacing.padding({ x: 4, y: 3 }),
  focusRing("&:focus-within", shadowVars.subtle),
  flex({ direction: "column", gap: 2 }),
  {
    cursor: "text",
    position: "relative",
    backgroundColor: backgroundColor.element,
    minWidth: 0,
    "& .ProseMirror": {
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
  },
);

const referenceResultsClass = style(radius.md, shadow.medium, {
  position: "absolute",
  left: 0,
  right: 0,
  zIndex: 5,
  maxHeight: "240px",
  overflowY: "auto",
  backgroundColor: backgroundColor.element,
  padding: spacing.value(2),
});

const referenceResultsAboveClass = style({ bottom: "calc(100% + 8px)" });
const referenceResultsBelowClass = style({ top: "calc(100% + 8px)" });

const referenceResultClass = style(
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

const referencePathClass = style({
  color: colors.gray[10],
  fontSize: "0.75em",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

function activeReferenceQuery(editor: TiptapEditor) {
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

const editorActionsClass = style(
  flex({ alignItems: "center", justifyContent: "end", gap: 3 }),
);

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter(Boolean).join(" ");
}
