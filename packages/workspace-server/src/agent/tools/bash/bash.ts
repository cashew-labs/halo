import path from "node:path";
import { Type } from "@sinclair/typebox";
import { haloTool } from "../HaloTool.js";
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

export const bashTool = haloTool({
  description:
    "Run a bash command in the active workspace. Timeout defaults to 10 seconds. Maximum 10 minutes. Long output shows its beginning and end; the full text is saved to a searchable file.",
  inputSchema: runInput,
  requiredCapabilities: ["workspace.shell.execute"],
  execute: async (input, context) => {
    const result = await runBash(context.workspaceRoot, {
      ...input,
      signal: context.signal,
      output: context.bashOutput ?? {
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
    return {
      result,
      modelResult: {
        content: [
          {
            type: "text",
            text: result.truncated
              ? `Exit code: ${result.code ?? "unknown"}\nOutput (stdout and stderr as received):\n${result.head}\n\n[${(result.outputChars - 40_000).toLocaleString()} characters omitted from the middle. Full output: ${result.fullOutputPath}. Search that file or read a narrow range to inspect the omitted content. Results from those tools are also capped.]\n\n${result.tail}`
              : `Exit code: ${result.code ?? "unknown"}\nstdout:\n${result.stdout || "(empty)"}\nstderr:\n${result.stderr || "(empty)"}`,
          },
        ],
        details: result,
      },
    };
  },
  modelTool: {
    name: "bash",
    replay: "unsafe",
  },
});
