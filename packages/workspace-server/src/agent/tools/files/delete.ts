import path from "node:path";
import * as errore from "errore";
import type { FilesystemService } from "../../../filesystem/FilesystemService.js";

export class FilesDeleteError extends errore.createTaggedError({
  name: "FilesDeleteError",
  message: "Failed to delete $path",
}) {}

export async function deleteFile(args: {
  filesystem: FilesystemService;
  cwd: string;
  input: { path: string };
}) {
  const absolutePath = path.resolve(args.cwd, args.input.path);
  const removed = await args.filesystem.unlink(absolutePath);
  if (removed instanceof Error) {
    return new FilesDeleteError({ path: args.input.path, cause: removed });
  }
  return { path: args.input.path };
}
