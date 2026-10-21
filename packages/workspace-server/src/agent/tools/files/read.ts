import path from "node:path";
import * as errore from "errore";
import { Type } from "@sinclair/typebox";
import { haloTool } from "../HaloTool.js";

/** The text file operations shared by workspace and device file tools. */
export type TextFiles = {
  readFile(path: string, encoding: "utf8"): Promise<string | Error>;
  writeFile(
    path: string,
    data: string,
    encoding: "utf8",
  ): Promise<void | Error>;
};

export class FilesReadError extends errore.createTaggedError({
  name: "FilesReadError",
  message: "Failed to read $path",
}) {}

export const readTool = haloTool({
  description:
    "Read a UTF-8 file in the active workspace. Use offset and limit for narrow reads. Long results show their beginning and end and save the full text to a searchable file.",
  inputSchema: Type.Object({
    path: Type.String(),
    offset: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Number()),
  }),
  requiredCapabilities: ["workspace.files.read"],
  execute: async (input, context) => {
    const result = await readFile({
      filesystem: context.services.filesystem,
      cwd: context.workspaceRoot,
      input,
    });
    if (result instanceof Error) return result;
    return {
      result,
      modelResult: {
        content: [{ type: "text", text: result.text }],
        details: result,
      },
    };
  },
  modelTool: {
    name: "read",
    replay: "safe",
  },
});

export async function readFile(args: {
  filesystem: TextFiles;
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
