import path from "node:path";
import * as errore from "errore";
import type { FilesystemService } from "../../../filesystem/FilesystemService.js";

export class FilesWriteError extends errore.createTaggedError({
  name: "FilesWriteError",
  message: "Failed to write $path",
}) {}

export async function writeFile(args: {
  filesystem: FilesystemService;
  cwd: string;
  input: { path: string; content: string };
}) {
  const absolutePath = path.resolve(args.cwd, args.input.path);
  const written = await args.filesystem.writeFile(
    absolutePath,
    args.input.content,
    "utf8",
  );
  if (written instanceof Error) {
    return new FilesWriteError({ path: args.input.path, cause: written });
  }
  return { path: args.input.path };
}
