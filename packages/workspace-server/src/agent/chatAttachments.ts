import childProcess from "node:child_process";
import path from "node:path";
import util from "node:util";
import buffer from "node:buffer";
import sharp from "sharp";
import convertHeic from "heic-convert";
import { decodeIco } from "icojs";
import { OfficeParser } from "officeparser";
import { convertToPng } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  chatAttachmentLimits,
  chatImageExtensions,
  type ChatAttachment,
} from "@get-halo/client";
import * as errore from "errore";
import type { FilesystemService } from "../filesystem/FilesystemService.js";
import type { ClaimedUpload } from "../uploads/UploadService.js";

type AttachmentContent = (TextContent | ImageContent)[];
const execFile = util.promisify(childProcess.execFile);
const documentExtensions = new Set([
  "docx",
  "pptx",
  "xlsx",
  "odt",
  "odp",
  "ods",
  "odg",
  "rtf",
  "epub",
]);

export class ChatAttachmentError extends errore.createTaggedError({
  name: "ChatAttachmentError",
  message: "Could not attach $fileName: $reason",
}) {}

/**
 * Converts uploaded files into model context. Files that are too large,
 * unreadable, or over the message budget stay in the workspace; the model gets
 * their paths so it can inspect them with its file tools.
 */
export async function prepareChatAttachments(input: {
  files: readonly ClaimedUpload[];
  filesystem: FilesystemService;
}) {
  const attachments: ChatAttachment[] = [];
  const content: AttachmentContent = [];
  for (const file of input.files) {
    attachments.push({
      name: file.name,
      path: file.path,
      size: file.size,
      mimeType: file.mimeType,
    });
    const header = `Attached file: ${JSON.stringify(file.name)}\nWorkspace path: ${JSON.stringify(file.path)}`;
    const included = await includedContent({
      file,
      filesystem: input.filesystem,
      textCharacters: content.reduce(
        (total, part) => total + (part.type === "text" ? part.text.length : 0),
        0,
      ),
      images: content.filter((part) => part.type === "image").length,
    });
    if (included instanceof Error) return included;
    if ("omitted" in included) {
      content.push({
        type: "text",
        text: `${header}\nSize: ${file.size} bytes\nThe contents are not included in this message: ${included.omitted}. Use the read, bash, or viewImage tools to inspect the file if you need it.`,
      });
      continue;
    }
    content.push(
      { type: "text", text: `${header}\nFile contents:` },
      ...included.content,
    );
  }
  return { attachments, content };
}

async function includedContent(input: {
  file: ClaimedUpload;
  filesystem: FilesystemService;
  textCharacters: number;
  images: number;
}) {
  if (input.file.size > chatAttachmentLimits.inlineBytes)
    return {
      omitted: `the file is larger than ${chatAttachmentLimits.inlineBytes / 1_000_000} MB`,
    };
  const bytes = await input.filesystem.readFile(input.file.absolutePath);
  if (bytes instanceof Error)
    return new ChatAttachmentError({
      fileName: input.file.name,
      reason: "could not read the uploaded file",
      cause: bytes,
    });
  const converted = await attachmentContent({
    bytes,
    absolutePath: input.file.absolutePath,
    filesystem: input.filesystem,
  });
  if (converted instanceof Error) {
    console.warn("Chat attachment was not converted:", converted);
    return { omitted: converted.reason };
  }
  const textCharacters = converted.reduce(
    (total, part) => total + (part.type === "text" ? part.text.length : 0),
    input.textCharacters,
  );
  if (textCharacters > chatAttachmentLimits.textCharacters)
    return {
      omitted: `its extracted text would exceed the ${chatAttachmentLimits.textCharacters.toLocaleString("en-US")}-character limit for one message`,
    };
  const images =
    input.images + converted.filter((part) => part.type === "image").length;
  if (images > chatAttachmentLimits.images)
    return {
      omitted: `it would exceed the limit of ${chatAttachmentLimits.images} images or PDF pages for one message`,
    };
  return { content: converted };
}

async function attachmentContent(input: {
  bytes: Buffer;
  absolutePath: string;
  filesystem: FilesystemService;
}): Promise<AttachmentContent | ChatAttachmentError> {
  const name = path.basename(input.absolutePath);
  const extension = path.extname(name).slice(1).toLowerCase();
  if (extension === "pdf" || input.bytes.subarray(0, 5).toString() === "%PDF-")
    return await pdfContent(input);
  if (chatImageExtensions.has(extension)) {
    const image = await imageContent({ bytes: input.bytes, name });
    if (image instanceof Error) return image;
    return [image];
  }
  if (documentExtensions.has(extension)) {
    const ast = await OfficeParser.parseOffice(input.absolutePath, {
      extractAttachments: true,
      abortSignal: AbortSignal.timeout(30_000),
    }).catch(
      (cause) =>
        new ChatAttachmentError({
          fileName: name,
          reason:
            "the document could not be read; it may be invalid or password-protected",
          cause,
        }),
    );
    if (ast instanceof Error) return ast;
    const extracted = await ast.to("text").catch(
      (cause) =>
        new ChatAttachmentError({
          fileName: name,
          reason: "could not extract document text",
          cause,
        }),
    );
    if (extracted instanceof Error) return extracted;
    const content: AttachmentContent = [
      { type: "text", text: extracted.value },
    ];
    for (const warning of ast.warnings) {
      console.warn("Chat attachment conversion:", name, warning.message);
      content.push({
        type: "text",
        text: `Document conversion note: ${warning.message}`,
      });
    }
    for (const attachment of ast.attachments) {
      if (attachment.type === "chart") {
        content.push({
          type: "text",
          text: `Chart ${attachment.name}: ${JSON.stringify(attachment.chartData)}`,
        });
        continue;
      }
      const image = await imageContent({
        bytes: Buffer.from(attachment.data, "base64"),
        name: `${name}: ${attachment.name}`,
      });
      if (image instanceof Error) return image;
      content.push(
        { type: "text", text: `Embedded image: ${attachment.name}` },
        image,
      );
    }
    return content;
  }
  if (buffer.isUtf8(input.bytes) && !input.bytes.includes(0))
    return [{ type: "text", text: input.bytes.toString("utf8") }];
  // UTF-16 exports are common for Windows text and tab-separated spreadsheets.
  if (input.bytes[0] === 0xff && input.bytes[1] === 0xfe)
    return [
      { type: "text", text: input.bytes.subarray(2).toString("utf16le") },
    ];
  if (
    input.bytes[0] === 0xfe &&
    input.bytes[1] === 0xff &&
    input.bytes.length % 2 === 0
  )
    return [
      {
        type: "text",
        text: Buffer.from(input.bytes.subarray(2)).swap16().toString("utf16le"),
      },
    ];
  return new ChatAttachmentError({
    fileName: name,
    reason:
      "Halo cannot extract text from this file format; it reads images, PDF, DOCX, XLSX, PPTX, OpenDocument, RTF, EPUB, and text files",
  });
}

async function imageContent(input: {
  bytes: Buffer;
  name: string;
}): Promise<ImageContent | ChatAttachmentError> {
  if (input.bytes.length === 0)
    return new ChatAttachmentError({
      fileName: input.name,
      reason: "the image is empty",
    });
  // libvips does not support BMP or ICO input.
  const extension = path.extname(input.name).toLowerCase();
  // Prebuilt libvips omits HEVC decoding; use the portable decoder for photos.
  if (extension === ".heic" || extension === ".heif") {
    const decoded = await convertHeic({
      buffer: input.bytes,
      format: "JPEG",
      quality: 0.9,
    }).catch(
      (cause) =>
        new ChatAttachmentError({
          fileName: input.name,
          reason: "the HEIC image could not be decoded",
          cause,
        }),
    );
    if (decoded instanceof Error) return decoded;
    return await imageContent({
      bytes: Buffer.from(decoded),
      name: `${input.name}.jpg`,
    });
  }
  if (extension === ".ico") {
    const icons = await decodeIco(input.bytes, "image/png").catch(
      (cause) =>
        new ChatAttachmentError({
          fileName: input.name,
          reason: "the icon could not be decoded",
          cause,
        }),
    );
    if (icons instanceof Error) return icons;
    const largest = icons.toSorted(
      (left, right) => right.width * right.height - left.width * left.height,
    )[0];
    if (largest === undefined)
      return new ChatAttachmentError({
        fileName: input.name,
        reason: "the icon contains no images",
      });
    return await imageContent({
      bytes: Buffer.from(largest.buffer),
      name: `${input.name}.png`,
    });
  }
  const converted =
    extension === ".bmp"
      ? await convertToPng(input.bytes.toString("base64"), "image/bmp")
      : undefined;
  if (converted === null)
    return new ChatAttachmentError({
      fileName: input.name,
      reason: "the image could not be decoded",
    });
  const bytes =
    converted === undefined
      ? input.bytes
      : Buffer.from(converted.data, "base64");
  const image = await sharp(bytes, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({
      width: 1600,
      height: 1600,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer()
    .catch(
      (cause) =>
        new ChatAttachmentError({
          fileName: input.name,
          reason: "the image could not be decoded",
          cause,
        }),
    );
  if (image instanceof Error) return image;
  return {
    type: "image",
    data: image.toString("base64"),
    mimeType: "image/jpeg",
  };
}

async function pdfCommand(input: {
  command: string;
  args: string[];
  name: string;
}) {
  return await execFile(input.command, input.args, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  }).catch(
    (cause) =>
      new ChatAttachmentError({
        fileName: input.name,
        reason:
          "the PDF could not be read; it may be invalid or password-protected, or Poppler may be missing on the workspace server",
        cause,
      }),
  );
}

async function pdfContent(input: {
  absolutePath: string;
  filesystem: FilesystemService;
}): Promise<AttachmentContent | ChatAttachmentError> {
  const name = path.basename(input.absolutePath);
  const info = await pdfCommand({
    command: "pdfinfo",
    args: [input.absolutePath],
    name,
  });
  if (info instanceof Error) return info;
  const pageCount = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1]);
  if (
    !Number.isInteger(pageCount) ||
    pageCount < 1 ||
    pageCount > chatAttachmentLimits.pdfPages
  )
    return new ChatAttachmentError({
      fileName: name,
      reason: `only PDFs with 1 to ${chatAttachmentLimits.pdfPages} pages are included`,
    });
  const text = await pdfCommand({
    command: "pdftotext",
    args: ["-layout", input.absolutePath, "-"],
    name,
  });
  if (text instanceof Error) return text;
  const content: AttachmentContent = [{ type: "text", text: text.stdout }];
  // Render every page, including scans, vector charts, annotations, and layout.
  const prefix = path.join(path.dirname(input.absolutePath), ".page");
  const rendered = await pdfCommand({
    command: "pdftoppm",
    args: ["-jpeg", "-scale-to", "1600", input.absolutePath, prefix],
    name,
  });
  if (rendered instanceof Error) return rendered;
  for (let page = 1; page <= pageCount; page++) {
    const pagePath = `${prefix}-${String(page).padStart(String(pageCount).length, "0")}.jpg`;
    const bytes = await input.filesystem.readFile(pagePath);
    if (bytes instanceof Error)
      return new ChatAttachmentError({
        fileName: name,
        reason: `could not read PDF page ${page}`,
        cause: bytes,
      });
    content.push(
      { type: "text", text: `PDF page ${page} of ${pageCount}` },
      { type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" },
    );
    const removed = await input.filesystem.unlink(pagePath);
    if (removed instanceof Error)
      console.warn("Could not remove rendered PDF page:", removed);
  }
  return content;
}
