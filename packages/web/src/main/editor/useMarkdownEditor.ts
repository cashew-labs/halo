import { useEffect } from "react";
import type { Editor, Extensions } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import { Markdown } from "@tiptap/markdown";
import Placeholder from "@tiptap/extension-placeholder";
import Paragraph from "@tiptap/extension-paragraph";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { colors, monoFontFamily } from "maui";
import { style, useStyles } from "purse-styles";
import { useRefCurrent } from "../agent/useRefCurrent.js";
import { ListEditing } from "./ListEditing.js";
import { MarkdownSyntax } from "./MarkdownSyntax.js";
import { serializeMarkdown } from "./serializeMarkdown.js";
import { MarkdownFormatting } from "./MarkdownFormatting.js";
import { EditorCursor } from "./EditorCursor.js";
import { EditorLinks } from "./EditorLinks.js";

const MarkdownParagraph = Paragraph.extend({
  parseMarkdown(token, helpers) {
    const tokens = token.tokens;
    // Tiptap unwraps standalone images as block nodes, but our inline images
    // must stay inside a paragraph.
    if (tokens?.length === 1 && tokens[0]?.type === "image") {
      return helpers.createNode(
        "paragraph",
        undefined,
        helpers.parseInline(tokens),
      );
    }
    // SAFETY: Tiptap's Paragraph extension defines parseMarkdown.
    return Paragraph.config.parseMarkdown!(token, helpers);
  },
});

type MarkdownEditorOptions = {
  content?: string;
  autoFocus?: boolean;
  onChange?: (markdown: string) => void;
  placeholder?: string;
  editable?: boolean;
  "aria-label"?: string;
  onSubmit?: () => void;
  onSelectionUpdate?: (editor: Editor) => void;
  onKeyDown?: (event: KeyboardEvent) => boolean;
  inlineCodeClassName?: string;
  extensions?: Extensions;
};

export function useMarkdownEditor({
  content = "",
  autoFocus = false,
  onChange,
  placeholder = "Write…",
  editable = true,
  "aria-label": ariaLabel = "Editor",
  onSubmit,
  onSelectionUpdate,
  onKeyDown,
  inlineCodeClassName,
  extensions = [],
}: MarkdownEditorOptions) {
  const syntaxClassName = useStyles(syntaxStyle);
  const onChangeRef = useRefCurrent(onChange);
  const onSubmitRef = useRefCurrent(onSubmit);
  const onSelectionUpdateRef = useRefCurrent(onSelectionUpdate);
  const onKeyDownRef = useRefCurrent(onKeyDown);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        paragraph: false,
        heading: { levels: [1, 2, 3, 4] },
        link: false,
        code: {
          HTMLAttributes: { class: inlineCodeClassName },
        },
      }),
      Link.extend({
        // Tiptap makes autolinks inclusive, which keeps typing at the end of a
        // pasted URL inside the link.
        inclusive: false,
      }).configure({ openOnClick: false }),
      Markdown,
      MarkdownParagraph,
      ...extensions,
      ListEditing,
      MarkdownFormatting,
      MarkdownSyntax,
      EditorCursor,
      EditorLinks,
      Placeholder.configure({
        placeholder,
      }),
    ],
    content,
    contentType: "markdown",
    autofocus: autoFocus,
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "aria-label": ariaLabel,
        class: syntaxClassName,
      },
      handleKeyDown: (_view, event) => {
        if (onKeyDownRef.current?.(event)) return true;
        if (
          onSubmitRef.current !== undefined &&
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey)
        ) {
          event.preventDefault();
          onSubmitRef.current?.();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: current }) => {
      onChangeRef.current?.(serializeMarkdown({ editor: current }));
      onSelectionUpdateRef.current?.(current);
    },
    onSelectionUpdate: ({ editor: current }) =>
      onSelectionUpdateRef.current?.(current),
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable, false);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor) return;
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: {
          ...editor.options.editorProps?.attributes,
          "aria-label": ariaLabel,
          class: syntaxClassName,
        },
      },
    });
  }, [editor, ariaLabel, syntaxClassName]);

  useEffect(() => {
    if (!editor) return;
    const current = serializeMarkdown({ editor });
    if (content === current) return;
    editor.commands.setContent(content, {
      contentType: "markdown",
      emitUpdate: false,
    });
  }, [editor, content]);

  return editor;
}

const syntaxStyle = style({
  "&.halo-custom-caret, &.halo-custom-caret .markdown-source": {
    caretColor: "transparent",
  },
  "&.halo-hover-caret, &.halo-hover-caret .markdown-source": { cursor: "none" },
  "& a": { cursor: "text" },
  "&.halo-link-modifier a": { cursor: "pointer", color: colors.accent[11] },
  "& .halo-selected-block": {
    position: "relative",
    isolation: "isolate",
  },
  "& .halo-selected-block::after": {
    content: '""',
    position: "absolute",
    insetBlock: 0,
    insetInline: "-6px",
    backgroundColor: colors.accentAlpha[4],
    borderRadius: 2,
    pointerEvents: "none",
    zIndex: -1,
  },
  "& .markdown-source": {
    outline: "none",
    whiteSpace: "pre-wrap",
  },
  "& .markdown-marker": {
    color: colors.gray[9],
    fontWeight: "normal",
    fontStyle: "normal",
  },
  "& .markdown-source-bold": { fontWeight: "bold" },
  "& .markdown-source-italic": { fontStyle: "italic" },
  "& .markdown-source-strike": { textDecoration: "line-through" },
  "& .markdown-source-code": { fontFamily: monoFontFamily },
});
