import type { Editor, JSONContent } from "@tiptap/core";

/** Keep literal code intact while Tiptap serializes the surrounding rich document. */
export function serializeMarkdown({
  editor,
  content = editor.getJSON(),
}: {
  editor: Editor;
  content?: JSONContent;
}) {
  // Tiptap 3 chooses mark delimiters using dummy text and moves surrounding
  // whitespace outside marks. Shield code text from both passes, then restore
  // complete CommonMark code spans. Other marks (such as links) stay on the token.
  const prefix = `HALOCODE${crypto.randomUUID().replaceAll("-", "")}X`;
  const codeSpans = new Map<string, string>();
  const prepare = (node: JSONContent): JSONContent => {
    if (
      node.type === "text" &&
      node.marks?.some((mark) => mark.type === "code")
    ) {
      const token = `${prefix}${codeSpans.size}END`;
      const text = node.text!;
      const longestRun = [...text.matchAll(/`+/g)].reduce(
        (longest, match) => Math.max(longest, match[0].length),
        0,
      );
      const delimiter = "`".repeat(longestRun + 1);
      const padding =
        text.startsWith("`") ||
        text.endsWith("`") ||
        (text.startsWith(" ") && text.endsWith(" ") && /[^ ]/.test(text))
          ? " "
          : "";
      codeSpans.set(
        token,
        `${delimiter}${padding}${text}${padding}${delimiter}`,
      );
      return {
        ...node,
        text: token,
        marks: node.marks.filter((mark) => mark.type !== "code"),
      };
    }
    return node.content === undefined
      ? node
      : { ...node, content: node.content.map(prepare) };
  };
  let markdown = editor.markdown!.serialize(prepare(content));
  for (const [token, code] of codeSpans)
    markdown = markdown.replaceAll(token, () => code);
  return markdown;
}
