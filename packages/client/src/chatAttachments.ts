import { Type, type Static } from "@sinclair/typebox";

// Upload sizes follow ChatGPT's published limits, in decimal megabytes as
// Finder and Explorer report them. Larger files than `inlineBytes` stay in the
// workspace for the agent's file tools instead of entering model context.
export const chatAttachmentLimits = {
  files: 10,
  fileBytes: 512_000_000,
  spreadsheetBytes: 50_000_000,
  imageBytes: 20_000_000,
  inlineBytes: 20_000_000,
  uploadChunkBytes: 8 * 1024 * 1024,
  textCharacters: 200_000,
  images: 40,
  pdfPages: 20,
} as const;

export const chatImageExtensions = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "tif",
  "tiff",
  "bmp",
  "ico",
  "heic",
  "heif",
]);
const spreadsheetExtensions = new Set(["xlsx", "xls", "ods", "csv", "tsv"]);

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
const threadReferenceSchema = Type.Object({
  // Keep saved references and older RPC clients readable.
  sessionId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
});
export const chatReferenceSchema = Type.Union([
  fileReferenceSchema,
  threadReferenceSchema,
]);
export type ChatReference = Static<typeof chatReferenceSchema>;
export type ChatPrompt = {
  text: string;
  /** Completed `uploads.create` uploads to attach, in display order. */
  uploadIds?: string[];
  references?: ChatReference[];
  clientMessageId?: string;
};

export function chatPromptContent(
  text: string,
  references: readonly ChatReference[],
  threadContents: ReadonlyMap<string, string> = new Map(),
) {
  if (references.length === 0) return text;
  const context = references.map((reference) => {
    if ("sessionId" in reference)
      return `Thread ${JSON.stringify(reference.title)} (${reference.sessionId}):\n${threadContents.get(reference.sessionId) ?? "No messages in this thread."}`;
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
    if (
      !file.name ||
      // oxlint-disable-next-line eslint/no-control-regex -- Reject control characters in filenames before writing attachments.
      /[/\\\u0000-\u001f]/.test(file.name) ||
      file.name === "." ||
      file.name === ".."
    )
      return "The attachment has an invalid filename.";
    if (file.size === 0) return `${file.name} is empty.`;
    const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
    const limit = chatImageExtensions.has(extension)
      ? { bytes: chatAttachmentLimits.imageBytes, kind: "Images" }
      : spreadsheetExtensions.has(extension)
        ? { bytes: chatAttachmentLimits.spreadsheetBytes, kind: "Spreadsheets" }
        : { bytes: chatAttachmentLimits.fileBytes, kind: "Files" };
    if (file.size > limit.bytes)
      return `${file.name} is too large. ${limit.kind} can be up to ${limit.bytes / 1_000_000} MB.`;
  }
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
    "New thread"
  );
}
