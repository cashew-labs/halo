import type React from "react";
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
import { useMarkdownEditor } from "../editor/useMarkdownEditor.js";
import {
  useReferencePicker,
  type ReferenceTarget,
} from "../ReferencePicker.js";

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
  referenceTargets?: ReferenceTarget[];
  onAddReference?: (target: ReferenceTarget) => void;
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
  referenceTargets,
  onAddReference,
  referencePlacement = "above",
}: EditorProps) {
  const shellClassName = useStyles(editorShellClass);
  const actionsClassName = useStyles(editorActionsClass);
  const inlineCodeClassName = useStyles(proseInlineCode);
  const picker = useReferencePicker({
    targets: onAddReference === undefined ? undefined : referenceTargets,
    enabled: onAddReference !== undefined,
    placement: referencePlacement,
    onSelect: (target, query) => {
      if (editor === null) return;
      editor
        .chain()
        .focus()
        .deleteRange({ from: query.from, to: query.to })
        .run();
      onAddReference?.(target);
    },
  });
  const editor = useMarkdownEditor({
    content,
    autoFocus,
    onChange,
    placeholder,
    editable,
    "aria-label": ariaLabel,
    onSubmit,
    onSelectionUpdate:
      onAddReference === undefined ? undefined : picker.onSelectionUpdate,
    onKeyDown: onAddReference === undefined ? undefined : picker.onKeyDown,
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
      {picker.menu}
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

const editorActionsClass = style(
  flex({ alignItems: "center", justifyContent: "end", gap: 3 }),
);

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter(Boolean).join(" ");
}
