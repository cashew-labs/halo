import path from "node:path";
import * as errore from "errore";
import type { FilesystemService } from "../../../filesystem/FilesystemService.js";

const maximumImageSizeBytes = 10 * 1024 * 1024;

const imageSignatures = [
  {
    mimeType: "image/png",
    matches: (contents: Buffer) =>
      contents.length >= 8 &&
      contents
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mimeType: "image/jpeg",
    matches: (contents: Buffer) =>
      contents.length >= 3 &&
      contents[0] === 0xff &&
      contents[1] === 0xd8 &&
      contents[2] === 0xff,
  },
  {
    mimeType: "image/webp",
    matches: (contents: Buffer) =>
      contents.length >= 12 &&
      contents.toString("ascii", 0, 4) === "RIFF" &&
      contents.toString("ascii", 8, 12) === "WEBP",
  },
] as const;

export class FilesViewImageError extends errore.createTaggedError({
  name: "FilesViewImageError",
  message: "Failed to view image $path: $reason",
}) {}

export async function viewImage(args: {
  filesystem: FilesystemService;
  cwd: string;
  input: { path: string };
}) {
  const filePath = args.input.path;
  const absolutePath = path.resolve(args.cwd, filePath);
  const contents = await args.filesystem.readFile(absolutePath);
  if (contents instanceof Error) {
    return new FilesViewImageError({
      path: filePath,
      reason: "could not read the file",
      cause: contents,
    });
  }

  if (contents.length > maximumImageSizeBytes) {
    return new FilesViewImageError({
      path: filePath,
      reason: "images must be 10 MiB or smaller",
    });
  }

  const image = imageSignatures.find(({ matches }) => matches(contents));
  if (image === undefined) {
    return new FilesViewImageError({
      path: filePath,
      reason: "expected PNG, JPEG, or WebP image data",
    });
  }

  return {
    path: filePath,
    mimeType: image.mimeType,
    sizeBytes: contents.length,
    data: contents.toString("base64"),
  };
}
