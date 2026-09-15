import { useEffect } from "react";
import type { Extensions } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import Placeholder from "@tiptap/extension-placeholder";
import Paragraph from "@tiptap/extension-paragraph";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { proseHtml, type ProseSize } from "maui";
import { useStyles } from "purse-styles";
import { useRefCurrent } from "./agent/useRefCurrent.js";
import { ListEditing } from "./ListEditing.js";

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
  size?: ProseSize;
  editable?: boolean;
  "aria-label"?: string;
  onSubmit?: () => void;
  inlineCodeClassName?: string;
  extensions?: Extensions;
};

export function useMarkdownEditor({
  content = "",
  autoFocus = false,
  onChange,
  placeholder = "Write…",
  size = "md",
  editable = true,
  "aria-label": ariaLabel = "Editor",
  onSubmit,
  inlineCodeClassName,
  extensions = [],
}: MarkdownEditorOptions) {
  const proseClassName = useStyles(proseHtml(size));
  const onChangeRef = useRefCurrent(onChange);
  const onSubmitRef = useRefCurrent(onSubmit);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        paragraph: false,
        heading: { levels: [1, 2, 3, 4] },
        link: {
          openOnClick: false,
        },
        code: {
          HTMLAttributes: {
            class: inlineCodeClassName,
          },
        },
      }),
      Markdown,
      MarkdownParagraph,
      ...extensions,
      ListEditing,
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
        class: `maui-editor-prose ${proseClassName}`,
      },
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onSubmitRef.current?.();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: current }) => {
      onChangeRef.current?.(current.getMarkdown());
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor) return;
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: {
          ...editor.options.editorProps?.attributes,
          "aria-label": ariaLabel,
          class: `maui-editor-prose ${proseClassName}`,
        },
      },
    });
  }, [editor, ariaLabel, proseClassName]);

  useEffect(() => {
    if (!editor) return;
    const current = editor.getMarkdown();
    if (content === current) return;
    editor.commands.setContent(content, { contentType: "markdown" });
  }, [editor, content]);

  return editor;
}
