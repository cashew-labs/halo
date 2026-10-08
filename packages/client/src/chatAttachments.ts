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
const fileReferenceSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  text: Type.Optional(Type.String({ minLength: 1 })),
});
const sessionReferenceSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
});
export const chatReferenceSchema = Type.Union([
  fileReferenceSchema,
  sessionReferenceSchema,
]);
export type ChatReference = Static<typeof chatReferenceSchema>;
export type ChatPrompt = {
  text: string;
  files?: File[];
  references?: ChatReference[];
  clientMessageId?: string;
};

export function chatPromptContent(
  text: string,
  references: readonly ChatReference[],
  sessionContents: ReadonlyMap<string, string> = new Map(),
) {
  if (references.length === 0) return text;
  const context = references.map((reference) => {
    if ("sessionId" in reference)
      return `Session ${JSON.stringify(reference.title)} (${reference.sessionId}):\n${sessionContents.get(reference.sessionId) ?? "No messages in this session."}`;
    return reference.text === undefined
      ? `File: ${JSON.stringify(reference.path)}. Read this workspace file if needed.`
      : `Selected text from ${JSON.stringify(reference.path)}:\n${reference.text}`;
  });
  return `${text}${text ? "\n\n" : ""}Workspace references:\n${context.join("\n\n")}`;
}

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
  references?: readonly ChatReference[];
}) {
  return (
    input.text.trim() ||
    input.files?.map((file) => file.name).join(", ") ||
    input.references
      ?.map((reference) =>
        "sessionId" in reference ? reference.title : reference.path,
      )
      .join(", ") ||
    "New session"
  );
}
