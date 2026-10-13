import path from "node:path";
import * as errore from "errore";
import { Type } from "@sinclair/typebox";
import { haloTool } from "../HaloTool.js";
import type { FilesystemService } from "../../../filesystem/FilesystemService.js";

export class FilesDeleteError extends errore.createTaggedError({
  name: "FilesDeleteError",
  message: "Failed to delete $path",
}) {}

export const deleteTool = haloTool({
  description: "Delete a workspace file.",
  inputSchema: Type.Object({ path: Type.String() }),
  requiredCapabilities: ["workspace.files.write"],
  execute: async (input, context) => {
    const result = await deleteFile({
      filesystem: context.services.filesystem,
      cwd: context.workspaceRoot,
      input,
    });
    if (result instanceof Error) return result;
    return { result };
  },
});

async function deleteFile(args: {
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
