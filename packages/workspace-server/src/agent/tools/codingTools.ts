import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolRuntime } from "../runtime/ToolRuntime.js";
import type { BashOutputResult } from "./bash/BashOutput.js";
import { maxBashToolTimeoutMs } from "./bash/run.js";

const readParameters = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});

const viewImageParameters = Type.Object({
  path: Type.String(),
});

const editParameters = Type.Object({
  path: Type.String(),
  oldText: Type.String(),
  newText: Type.String(),
  replaceAll: Type.Optional(Type.Boolean()),
});

const writeParameters = Type.Object({
  path: Type.String(),
  content: Type.String(),
});

const patchParameters = Type.Object({
  patchText: Type.String({ description: "Patch in apply_patch format." }),
});

const bashParameters = Type.Object({
  command: Type.String(),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: maxBashToolTimeoutMs,
      description: `Timeout in milliseconds. Defaults to 10000. Maximum ${maxBashToolTimeoutMs} (10 minutes).`,
    }),
  ),
});

export function createCodingTools(input: {
  cwd: string;
  threadId: string;
  modelId: string;
  runtime: ToolRuntime;
}) {
  const invoke: ToolRuntime["invoke"] = async <T>(
    args: Parameters<ToolRuntime["invoke"]>[0],
  ) =>
    await input.runtime.invoke<T>({
      ...args,
      threadId: input.threadId,
      modelId: input.modelId,
    });
  return [
    createReadTool(invoke),
    createViewImageTool(invoke),
    createEditTool(invoke),
    createWriteTool(invoke),
    createPatchTool(invoke),
    createBashTool(invoke, input.cwd, input.threadId),
  ] as const;
}

function createBashTool(
  invoke: ToolRuntime["invoke"],
  cwd: string,
  sessionId: string,
): AgentTool<
  typeof bashParameters,
  BashOutputResult & { code: number | null }
> {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Run a bash command in the active workspace. Timeout defaults to 10 seconds. Maximum 10 minutes. Long output shows its beginning and end; the full text is saved to a searchable file.",
    parameters: bashParameters,
    async execute(toolCallId, params, signal) {
      const invocation = await invoke<
        BashOutputResult & { code: number | null }
      >({
        pluginId: "bash",
        toolName: "run",
        args: params,
        toolCallId,
        signal,
        bashOutput: {
          directory: path.join(cwd, ".halo", "tool-outputs", sessionId),
          headChars: 8_000,
          tailChars: 32_000,
        },
      });
      if (invocation instanceof Error) throw invocation;
      const result = invocation.value;
      const text = result.truncated
        ? `Exit code: ${result.code ?? "unknown"}\nOutput (stdout and stderr as received):\n${result.head}\n\n[${(result.outputChars - 40_000).toLocaleString()} characters omitted from the middle. Full output: ${result.fullOutputPath}. Search that file or read a narrow range to inspect the omitted content. Results from those tools are also capped.]\n\n${result.tail}`
        : `Exit code: ${result.code ?? "unknown"}\nstdout:\n${result.stdout || "(empty)"}\nstderr:\n${result.stderr || "(empty)"}`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  };
}

function createPatchTool(
  invoke: ToolRuntime["invoke"],
): AgentTool<
  typeof patchParameters,
  { added: string[]; modified: string[]; deleted: string[] }
> {
  return {
    name: "patch",
    label: "Patch",
    description: "Apply an apply_patch patch to files in the active workspace.",
    parameters: patchParameters,
    async execute(toolCallId, params, signal) {
      const invocation = await invoke<{
        added: string[];
        modified: string[];
        deleted: string[];
      }>({
        pluginId: "files",
        toolName: "patch",
        args: params,
        toolCallId,
        signal,
      });
      if (invocation instanceof Error) throw invocation;
      const result = invocation.value;
      return {
        content: [{ type: "text", text: JSON.stringify(result, undefined, 2) }],
        details: result,
      };
    },
  };
}

function createReadTool(
  invoke: ToolRuntime["invoke"],
): AgentTool<typeof readParameters, { path: string; text: string }> {
  return {
    name: "read",
    label: "Read",
    description:
      "Read a UTF-8 file in the active workspace. Use offset and limit for narrow reads. Long results show their beginning and end and save the full text to a searchable file.",
    parameters: readParameters,
    async execute(toolCallId, params, signal) {
      const invocation = await invoke<{ path: string; text: string }>({
        pluginId: "files",
        toolName: "read",
        args: params,
        toolCallId,
        signal,
      });
      if (invocation instanceof Error) throw invocation;
      const result = invocation.value;
      return {
        content: [{ type: "text", text: result.text }],
        details: result,
      };
    },
  };
}

function createViewImageTool(
  invoke: ToolRuntime["invoke"],
): AgentTool<
  typeof viewImageParameters,
  { path: string; mimeType: string; sizeBytes: number }
> {
  return {
    name: "viewImage",
    label: "View image",
    description:
      "View a PNG, JPEG, or WebP image from the active workspace. Source images must be 20 MiB or smaller.",
    parameters: viewImageParameters,
    async execute(toolCallId, params, signal) {
      const invocation = await invoke<{
        path: string;
        mimeType: string;
        sizeBytes: number;
        data: string;
      }>({
        pluginId: "files",
        toolName: "viewImage",
        args: params,
        toolCallId,
        signal,
      });
      if (invocation instanceof Error) throw invocation;
      const result = invocation.value;
      return {
        content: [
          { type: "text", text: `Viewed image ${result.path}.` },
          {
            type: "image",
            data: result.data,
            mimeType: result.mimeType,
          },
        ],
        details: {
          path: result.path,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
        },
      };
    },
  };
}

function createEditTool(
  invoke: ToolRuntime["invoke"],
): AgentTool<typeof editParameters, { path: string; replacements: number }> {
  return {
    name: "edit",
    label: "Edit",
    description: "Replace exact text in a workspace file.",
    parameters: editParameters,
    async execute(toolCallId, params, signal) {
      const invocation = await invoke<{ path: string; replacements: number }>({
        pluginId: "files",
        toolName: "edit",
        args: params,
        toolCallId,
        signal,
      });
      if (invocation instanceof Error) throw invocation;
      const result = invocation.value;
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}

function createWriteTool(
  invoke: ToolRuntime["invoke"],
): AgentTool<typeof writeParameters, { path: string }> {
  return {
    name: "write",
    label: "Write",
    description: "Write a UTF-8 file in the active workspace.",
    parameters: writeParameters,
    async execute(toolCallId, params, signal) {
      const invocation = await invoke<{ path: string }>({
        pluginId: "files",
        toolName: "write",
        args: params,
        toolCallId,
        signal,
      });
      if (invocation instanceof Error) throw invocation;
      const result = invocation.value;
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
