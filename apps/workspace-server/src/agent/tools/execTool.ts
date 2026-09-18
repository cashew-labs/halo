import type { ExecToolCall } from "@get-halo/client";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { formatExecuteResult } from "@executor-js/execution/core";
import { Type } from "typebox";
import {
  ConnectionRequiredError,
  type ExecActivityUpdate,
  type ToolRuntime,
  ToolApprovalRequiredError,
} from "../runtime/ToolRuntime.js";

const execParameters = Type.Object({
  js: Type.String({ description: "JavaScript to run. tools is in scope." }),
});

export function createExecTool(input: {
  runtime: ToolRuntime;
  runtimeDescription: string;
  modelId: string;
  onToolEvent?: (event: ExecActivityUpdate) => void;
  consumeApproval: Parameters<ToolRuntime["executeCode"]>[0]["consumeApproval"];
}): AgentHarnessTool<object | undefined> {
  return {
    name: "exec",
    label: "Exec",
    description: input.runtimeDescription,
    parameters: execParameters,
    async execute(id, params, onUpdate, _toolContext, _invocation, context) {
      // SAFETY: execParameters schema guarantees params has a string `js` property.
      const { js } = params as { js: string };
      const toolCalls = new Map<string, ExecToolCall>();
      const result = await input.runtime.executeCode({
        code: js,
        signal: context.abortSignal,
        modelId: input.modelId,
        parentToolCallId: id,
        consumeApproval: input.consumeApproval,
        onToolEvent: (event) => {
          input.onToolEvent?.(event);
          if (event.type === "tool.started") {
            toolCalls.set(event.invocation.id, {
              ...event.invocation,
              status: "running",
            });
          } else {
            const call = toolCalls.get(event.invocationId)!;
            toolCalls.set(call.id, {
              ...call,
              status: event.isError ? "failed" : "completed",
            });
          }
          // Pi persists progress only when the harness checkpoint option is set.
          onUpdate(
            {
              content: [],
              details: {
                toolCalls: [...toolCalls.values()],
                toolApprovals: [],
              },
            },
            { checkpoint: true },
          );
        },
      });
      if (result instanceof ConnectionRequiredError) {
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: {
            error: result.message,
            toolCalls: [...toolCalls.values()],
            toolApprovals: [],
            connectionRequests: result.connectionRequests,
          },
        };
      }
      if (result instanceof ToolApprovalRequiredError) {
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: {
            error: result.message,
            toolCalls: [...toolCalls.values()],
            toolApprovals: result.approvals,
          },
        };
      }
      if (result instanceof Error) {
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: {
            error: result.message,
            toolCalls: [...toolCalls.values()],
            toolApprovals: [],
          },
          isError: true,
        };
      }
      const formatted = formatExecuteResult(result);
      return {
        content: [{ type: "text" as const, text: formatted.text }],
        details: {
          ...formatted.structured,
          toolCalls: [...toolCalls.values()],
          toolApprovals: [],
        },
        isError: formatted.isError,
      };
    },
  };
}
