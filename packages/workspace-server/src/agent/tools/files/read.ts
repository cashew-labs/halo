import path from "node:path";
import * as errore from "errore";
import type { FilesystemService } from "../../../filesystem/FilesystemService.js";

export class FilesReadError extends errore.createTaggedError({
  name: "FilesReadError",
  message: "Failed to read $path",
}) {}

export async function readFile(args: {
  filesystem: FilesystemService;
  cwd: string;
  input: {
    path: string;
    offset?: number;
    limit?: number;
  };
}) {
  const { path: filePath, offset, limit } = args.input;
  const absolutePath = path.resolve(args.cwd, filePath);
  const raw = await args.filesystem.readFile(absolutePath, "utf8");
  if (raw instanceof Error) {
    return new FilesReadError({ path: filePath, cause: raw });
  }

  if (offset === undefined && limit === undefined) {
    return { path: filePath, text: raw };
  }

  const lines = raw.split("\n");
  const startLine = offset === undefined ? 0 : Math.max(0, offset - 1);
  if (startLine >= lines.length) {
    return new FilesReadError({
      path: filePath,
      cause: new Error(
        `Offset ${offset} is beyond end of file (${lines.length} lines total)`,
      ),
    });
  }

  const endLine =
    limit === undefined
      ? lines.length
      : Math.min(startLine + limit, lines.length);
  return { path: filePath, text: lines.slice(startLine, endLine).join("\n") };
}
