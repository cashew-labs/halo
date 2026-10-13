import path from "node:path";
import * as errore from "errore";
import { Type } from "@sinclair/typebox";
import { haloTool } from "../HaloTool.js";
import type { FilesystemService } from "../../../filesystem/FilesystemService.js";

export class FilesWriteError extends errore.createTaggedError({
  name: "FilesWriteError",
  message: "Failed to write $path",
}) {}

export const writeTool = haloTool({
  description: "Write a UTF-8 file in the active workspace.",
  inputSchema: Type.Object({ path: Type.String(), content: Type.String() }),
  requiredCapabilities: ["workspace.files.write"],
  execute: async (input, context) => {
    const result = await writeFile({
      filesystem: context.services.filesystem,
      cwd: context.workspaceRoot,
      input,
    });
    if (result instanceof Error) return result;
    return {
      result,
      modelResult: {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      },
    };
  },
  modelTool: {
    name: "write",
    replay: "unsafe",
  },
});

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
