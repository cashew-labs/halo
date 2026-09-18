import { Type } from "@sinclair/typebox";
import { defineHaloTool, type HaloToolPlugin } from "../HaloToolPlugin.js";
import { maxBashTimeoutMs, runBash } from "./run.js";

const runInput = Type.Object({
  command: Type.String(),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: maxBashTimeoutMs,
      description: `Timeout in milliseconds. Defaults to 10000. Maximum ${maxBashTimeoutMs} (10 minutes).`,
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
        "Run a Bash command in the active Halo workspace. Timeout defaults to 10 seconds. Maximum 10 minutes.",
      inputSchema: runInput,
      requiredCapabilities: ["workspace.shell.execute"],
      execute: async (input, context) => {
        const result = await runBash(context.workspaceRoot, {
          ...input,
          signal: context.signal,
        });
        if (result instanceof Error) return result;
        return { value: result };
      },
    }),
  ],
};
