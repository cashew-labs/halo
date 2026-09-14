import type {
  HarnessEvent,
  LaneSnapshot,
  Entry,
} from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  directToolIdentity,
  execToolCallSchema,
  executionWithOutput,
  type ToolResult,
  type HaloEntry,
  type SessionEvent,
  type SessionSnapshot,
  type ToolExecution,
  type ToolOutput,
} from "@get-halo/shared/sessionState";

const execDetailsSchema = Type.Object({
  toolCalls: Type.Array(execToolCallSchema),
});

function toolOutput(name: string, result: ToolResult): ToolOutput {
  if (name !== "exec") return { type: "tool", result };
  // Pi can reject a tool before exec.execute runs, producing a result without Halo details.
  if (!Value.Check(execDetailsSchema, result.details))
    return { type: "exec", result, calls: [] };
  const { toolCalls, ...details } = result.details;
  return { type: "exec", result: { ...result, details }, calls: toolCalls };
}

function toolExecution(
  id: string,
  name: string,
  args: ToolExecution["arguments"],
): ToolExecution {
  const execution = {
    id,
    tool: directToolIdentity(name),
    arguments: args,
    status: "running" as const,
  };
  if (name === "exec") return { ...execution, type: "exec", calls: [] };
  return { ...execution, type: "tool" };
}

function sessionEntry(entry: Extract<Entry, { type: "message" }>): HaloEntry {
  const message = entry.message;
  if (message.role !== "toolResult")
    return { type: "message", id: entry.id, message };
  return {
    type: "toolResult",
    id: entry.id,
    toolCallId: message.toolCallId,
    tool: directToolIdentity(message.toolName),
    timestamp: message.timestamp,
    isError: message.isError,
    output: toolOutput(message.toolName, {
      content: message.content,
      details: message.details,
      usage: message.usage,
      addedToolNames: message.addedToolNames,
    }),
  };
}

export function sessionSnapshot(snapshot: LaneSnapshot): SessionSnapshot {
  const operation = snapshot.operation;
  const last = snapshot.lastResult;
  return {
    entries: snapshot.transcript.flatMap((entry) =>
      entry.type === "message" ? [sessionEntry(entry)] : [],
    ),
    activeRun:
      operation === null
        ? undefined
        : {
            id: operation.id,
            message: operation.streamingMessage,
            tools: operation.runningTools.map((tool) => {
              const execution = toolExecution(
                tool.toolCallId,
                tool.toolName,
                tool.args,
              );
              if (tool.result === undefined) return execution;
              return executionWithOutput(
                execution,
                toolOutput(tool.toolName, tool.result),
                tool.status === "settled"
                  ? tool.isError
                    ? "failed"
                    : "completed"
                  : "running",
              );
            }),
          },
    lastRun:
      last === undefined
        ? undefined
        : {
            id: last.operationId,
            status: last.status,
            error: last.error?.message,
          },
    fault: snapshot.faulted
      ? "The session encountered a storage error."
      : undefined,
  };
}

export function adaptPiEvent(event: HarnessEvent): SessionEvent | undefined {
  switch (event.type) {
    case "fault":
      return { type: "session.failed", error: event.message };
    case "run_start":
      return { type: "run.started", runId: event.runId };
    case "run_end":
      return {
        type: "run.finished",
        run: {
          id: event.runId,
          status: event.status,
          error: event.error?.message,
        },
      };
    case "entry_added":
      return event.entry.type === "message"
        ? { type: "entry.committed", entry: sessionEntry(event.entry) }
        : undefined;
    case "message_update": {
      const update = event.event;
      const message =
        update.type === "done"
          ? update.message
          : update.type === "error"
            ? update.error
            : update.partial;
      return { type: "message.updated", runId: event.runId, message };
    }
    case "tool_start":
      return {
        type: "tool.started",
        runId: event.runId,
        execution: toolExecution(event.toolCallId, event.toolName, event.args),
      };
    case "tool_update":
      return {
        type: "tool.updated",
        runId: event.runId,
        toolCallId: event.toolCallId,
        output: toolOutput(event.toolName, event.partialResult),
        status: "running",
      };
    case "tool_end":
      return {
        type: "tool.updated",
        runId: event.runId,
        toolCallId: event.toolCallId,
        output: toolOutput(event.toolName, event.result),
        status: event.isError ? "failed" : "completed",
      };
    default:
      return undefined;
  }
}
