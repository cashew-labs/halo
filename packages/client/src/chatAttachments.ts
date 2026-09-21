import { Type, type Static } from "@sinclair/typebox";

export const chatAttachmentLimits = {
  files: 10,
  fileBytes: 20 * 1024 * 1024,
  totalBytes: 40 * 1024 * 1024,
  textCharacters: 200_000,
  images: 40,
  pdfPages: 20,
} as const;

export const chatAttachmentSchema = Type.Object({
  name: Type.String(),
  path: Type.String(),
  size: Type.Number(),
  mimeType: Type.String(),
});

export type ChatAttachment = Static<typeof chatAttachmentSchema>;
export type ChatPrompt = { text: string; files?: File[] };

export function validateChatFiles(
  files: readonly Pick<File, "name" | "size">[],
) {
  if (files.length > chatAttachmentLimits.files)
    return "Attach up to 10 files per message.";
  for (const file of files) {
    if (file.size > chatAttachmentLimits.fileBytes)
      return `${file.name} is too large. Each attachment must be 20 MiB or smaller.`;
    if (file.size === 0) return `${file.name} is empty.`;
    if (
      !file.name ||
      // oxlint-disable-next-line eslint/no-control-regex -- Reject control characters in filenames before writing attachments.
      /[/\\\u0000-\u001f]/.test(file.name) ||
      file.name === "." ||
      file.name === ".."
    )
      return "The attachment has an invalid filename.";
  }
  if (
    files.reduce((size, file) => size + file.size, 0) >
    chatAttachmentLimits.totalBytes
  )
    return "Attachments must total 40 MiB or less per message.";
  return undefined;
}

export function chatPromptTitle(input: {
  text: string;
  files?: readonly { name: string }[];
}) {
  return (
    input.text.trim() ||
    input.files?.map((file) => file.name).join(", ") ||
    "New session"
  );
}
