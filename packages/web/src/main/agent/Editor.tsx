import type React from "react";
import { EditorContent } from "@tiptap/react";
import {
  backgroundColor,
  colors,
  flex,
  focusRing,
  proseMaxWidth,
  radius,
  shadow,
  shadowVars,
  spacing,
  type ProseSize,
} from "maui";
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
  error?: React.ReactNode;
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
  error,
}: EditorProps) {
  const shellClassName = useStyles(editorShellClass);
  const actionsClassName = useStyles(editorActionsClass);
  const inlineCodeClassName = useStyles(proseInlineCode);
  const editor = useMarkdownEditor({
    content,
    autoFocus,
    onChange,
    placeholder,
    size,
    editable,
    "aria-label": ariaLabel,
    onSubmit,
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
      <EditorContent editor={editor} />
      {error}
      {actions ? <div className={actionsClassName}>{actions}</div> : undefined}
    </div>
  );
}

const editorShellClass = style(
  radius.lg,
  shadow.subtle,
  spacing.padding({ x: 4, y: 3 }),
  focusRing("&:focus-within", shadowVars.subtle),
  flex({ direction: "column", gap: 2 }),
  {
    cursor: "text",
    backgroundColor: backgroundColor.element,
    maxWidth: proseMaxWidth,
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

const editorActionsClass = style(
  flex({ alignItems: "center", justifyContent: "end", gap: 3 }),
);

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter(Boolean).join(" ");
}
