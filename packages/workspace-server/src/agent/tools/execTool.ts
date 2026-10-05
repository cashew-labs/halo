import type { ExecToolCall } from "@get-halo/client";
import { copyJson } from "@earendil-works/chord";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { formatExecuteResult } from "@executor-js/execution/core";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import { Type as SchemaType } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Type } from "typebox";
import * as errore from "errore";
import {
  ConnectionRequiredError,
  ToolApprovalRequiredError,
  type ToolRuntime,
} from "../runtime/ToolRuntime.js";

const execParameters = Type.Object({
  js: Type.String({ description: "JavaScript to run. tools is in scope." }),
});

class ToolProgressError extends errore.createTaggedError({
  name: "ToolProgressError",
  message: "Could not persist tool progress",
}) {}

export function createExecTool(input: {
  runtime: ToolRuntime;
  runtimeDescription: string;
  modelId: string;
  threadId: string;
  consumeApproval: Parameters<ToolRuntime["executeCode"]>[0]["consumeApproval"];
}): ToolRegistration<typeof execParameters> {
  return defineTool({
    name: "exec",
    description: input.runtimeDescription,
    parameters: execParameters,
    replay: "unsafe",
    async execute(args, api, context) {
      const { js } = args;
      const toolCalls = new Map<string, ExecToolCall>();
      const progressQueue = new SerialQueue();
      const progressUpdates: Promise<void | ToolProgressError>[] = [];
      const result = await input.runtime.executeCode({
        code: js,
        signal: context.abortSignal,
        modelId: input.modelId,
        parentToolCallId: api.callId,
        threadId: input.threadId,
        consumeApproval: input.consumeApproval,
        onToolEvent: (event) => {
          const update = progressQueue
            .run(async () => {
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
              await api.details(
                copyJson(
                  { toolCalls: [...toolCalls.values()] },
                  { omitUndefinedProperties: true },
                ),
                context,
              );
            })
            .catch((cause) => new ToolProgressError({ cause }));
          progressUpdates.push(update);
        },
      });
      const progressResults = await Promise.all(progressUpdates);
      const progressFailure = progressResults.find(
        (progress) => progress instanceof Error,
      );
      // Pi's tool boundary requires thrown failures.
      if (progressFailure instanceof Error) throw progressFailure;
      if (result instanceof ToolApprovalRequiredError) {
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: copyJson(
            {
              error: result.message,
              toolCalls: [...toolCalls.values()],
              toolApprovals: result.approvals,
            },
            { omitUndefinedProperties: true },
          ),
        };
      }
      if (result instanceof ConnectionRequiredError) {
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: copyJson(
            {
              error: result.message,
              toolCalls: [...toolCalls.values()],
              connectionRequests: result.connectionRequests,
            },
            { omitUndefinedProperties: true },
          ),
        };
      }
      if (result instanceof Error) {
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: copyJson(
            {
              error: result.message,
              toolCalls: [...toolCalls.values()],
            },
            { omitUndefinedProperties: true },
          ),
          isError: true,
        };
      }
      const formatted = formatExecuteResult(result);
      const value = result.result ?? undefined;
      const resultText =
        value === undefined
          ? undefined
          : Value.Check(SchemaType.String(), value)
            ? value
            : JSON.stringify(value, undefined, 2);
      const logs =
        result.logs && result.logs.length > 0
          ? `\nLogs:\n${result.logs.join("\n")}`
          : "";
      const fullText = result.error
        ? `Error: ${result.error}${logs}`
        : resultText === undefined
          ? formatted.text
          : `${resultText}${logs}`;
      return {
        content: [{ type: "text" as const, text: fullText }],
        details: copyJson(
          {
            ...formatted.structured,
            toolCalls: [...toolCalls.values()],
          },
          { omitUndefinedProperties: true },
        ),
        isError: formatted.isError,
      };
    },
  });
}
