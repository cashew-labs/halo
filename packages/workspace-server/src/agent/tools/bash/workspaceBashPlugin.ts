import path from "node:path";
import { Type } from "@sinclair/typebox";
import { defineHaloTool, type HaloToolPlugin } from "../HaloToolPlugin.js";
import { maxBashToolTimeoutMs, runBash } from "./run.js";

const runInput = Type.Object({
  command: Type.String(),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: maxBashToolTimeoutMs,
      description: `Timeout in milliseconds. Defaults to 10000. Maximum ${maxBashToolTimeoutMs} (10 minutes).`,
    }),
  ),
});

export const workspaceBashPlugin: HaloToolPlugin = {
  id: "bash",
  name: "Workspace shell",
  tools: [
    defineHaloTool({
      name: "run",
      description:
        "Run a Bash command in the active Halo workspace. Timeout defaults to 10 seconds. Maximum 10 minutes. Long output includes a path to the full streamed output file.",
      inputSchema: runInput,
      requiredCapabilities: ["workspace.shell.execute"],
      execute: async (input, context) => {
        const result = await runBash(context.workspaceRoot, {
          ...input,
          signal: context.signal,
          output: {
            directory: path.join(
              context.workspaceRoot,
              ".halo",
              "tool-outputs",
              "integrations",
            ),
            headChars: 4_000,
            tailChars: 16_000,
          },
        });
        if (result instanceof Error) return result;
        return { value: result };
      },
    }),
  ],
};
