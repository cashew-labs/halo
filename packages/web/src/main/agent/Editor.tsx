import { HybridMarkdownEditor } from "../HybridMarkdownEditor.js";
import type React from "react";
import {
  backgroundColor,
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
  },
);

const editorActionsClass = style(
  flex({ align: "center", justify: "end", gap: 3 }),
);

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter(Boolean).join(" ");
}

export function Editor(props: EditorProps) {
  const shellClassName = useStyles(editorShellClass);
  const actionsClassName = useStyles(editorActionsClass);
  return (
    <div
      className={joinClassNames(shellClassName, props.className)}
      onClick={(event) => {
        const editable = event.currentTarget.querySelector<HTMLElement>(
          '[contenteditable="true"]',
        );
        if (event.target instanceof Node && editable?.contains(event.target))
          return;
        editable?.focus();
      }}
    >
      <HybridMarkdownEditor
        content={props.content ?? ""}
        autoFocus={props.autoFocus}
        onChange={(value) => props.onChange?.(value)}
        placeholder={props.placeholder ?? "Write a message…"}
        size={props.size}
        editable={props.editable}
        aria-label={props["aria-label"] ?? "Message editor"}
        onSubmit={props.onSubmit}
      />
      {props.error}
      {props.actions ? (
        <div className={actionsClassName}>{props.actions}</div>
      ) : undefined}
    </div>
  );
}
