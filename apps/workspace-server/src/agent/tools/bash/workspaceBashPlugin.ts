import { Type } from "@sinclair/typebox";
import { defineHaloTool, type HaloToolPlugin } from "../HaloToolPlugin.js";
import { runBash } from "./run.js";

const runInput = Type.Object({
  command: Type.String(),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Timeout in milliseconds. Defaults to 10000.",
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
        "Run a Bash command in the active Halo workspace. Timeout defaults to 10 seconds.",
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
