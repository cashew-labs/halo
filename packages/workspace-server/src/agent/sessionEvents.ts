import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { MessagePresentation } from "./SessionProjection.js";
import {
  directToolIdentity,
  execToolCallSchema,
  toolApprovalSchema,
  executionWithOutput,
  type HaloMessage,
  type HaloEntry,
  type SessionEvent,
  type SessionSnapshot,
  type HaloConnectionState,
  type ToolResult,
  type ToolExecution,
  type ToolOutput,
} from "@get-halo/client";

const execDetailsSchema = Type.Object({
  toolCalls: Type.Array(execToolCallSchema),
  toolApprovals: Type.Optional(Type.Array(toolApprovalSchema)),
});

function toolOutput(name: string, result: ToolResult): ToolOutput {
  if (name !== "exec") return { type: "tool", result };
  if (!Value.Check(execDetailsSchema, result.details))
    return { type: "exec", result, calls: [], approvals: [] };
  const { toolCalls, toolApprovals, ...details } = result.details;
  return {
    type: "exec",
    result: { ...result, details },
    calls: toolCalls,
    approvals: toolApprovals ?? [],
  };
}

export function sessionEntry(
  entry: EntryRecord,
  presentation?: MessagePresentation,
): HaloEntry | undefined {
  if (entry.kind === "pi.compaction") return;
  // SAFETY: Halo-authored entries store this display payload independently of model context.
  const data = entry.data as { message?: HaloMessage } | undefined;
  const source = data?.message ?? entry.model?.[0];
  if (source === undefined || source.role === "system") return;
  // SAFETY: Pi records are JSON; Halo's public schema uses mutable arrays for transport.
  const message = { ...source, ...presentation } as HaloMessage;
  const id = String(entry.id);
  if (message.role !== "toolResult") return { type: "message", id, message };
  return {
    type: "toolResult",
    id,
    toolCallId: message.toolCallId,
    tool: directToolIdentity(message.toolName),
    timestamp: message.timestamp,
    isError: message.isError,
    output: toolOutput(message.toolName, message),
  };
}

export function sessionSnapshot(input: {
  live: LiveState;
  entries: HaloEntry[];
  lastRun: SessionSnapshot["lastRun"];
  connections: HaloConnectionState[];
}): SessionSnapshot {
  const { live, entries, lastRun, connections } = input;
  // SAFETY: The committed generation message is Pi's serialized AssistantMessage.
  const message = live.generation?.message as
    | Extract<HaloMessage, { role: "assistant" }>
    | undefined;
  return {
    entries,
    lastRun,
    connections,
    fault: undefined,
    activeRun:
      live.run === undefined
        ? undefined
        : {
            id: String(live.run.inputs[0]),
            message,
            tools: (live.tools ?? [])
              .filter((slot) => slot.status !== "done")
              .map((slot): ToolExecution => {
                const call = entries
                  .flatMap((entry) =>
                    entry.type === "message" &&
                    entry.message.role === "assistant"
                      ? entry.message.content.filter(
                          (part) =>
                            part.type === "toolCall" && part.id === slot.callId,
                        )
                      : [],
                  )
                  .at(-1);
                const base = {
                  id: slot.callId,
                  tool: directToolIdentity(slot.name),
                  arguments: call?.type === "toolCall" ? call.arguments : {},
                  status: "running" as const,
                };
                const execution: ToolExecution =
                  slot.name === "exec"
                    ? { ...base, type: "exec", calls: [], approvals: [] }
                    : { ...base, type: "tool" };
                const result = entries.findLast(
                  (entry) =>
                    entry.type === "toolResult" &&
                    entry.toolCallId === slot.callId,
                );
                if (result?.type === "toolResult")
                  return executionWithOutput(
                    execution,
                    result.output,
                    result.isError ? "failed" : "completed",
                  );
                if (slot.output === undefined && slot.details === undefined)
                  return execution;
                return executionWithOutput(
                  execution,
                  toolOutput(slot.name, {
                    content:
                      slot.output === undefined
                        ? []
                        : [{ type: "text", text: slot.output }],
                    details: slot.details,
                  }),
                  "running",
                );
              }),
          },
  };
}

/** Project committed state transitions into Halo's existing transport events. */
export function sessionEvents(
  before: SessionSnapshot,
  after: SessionSnapshot,
): SessionEvent[] {
  const events: SessionEvent[] = [];
  const run = after.activeRun;
  const known = new Set(before.entries.map((entry) => entry.id));
  for (const entry of after.entries)
    if (!known.has(entry.id)) events.push({ type: "entry.committed", entry });
  if (
    before.activeRun !== undefined &&
    before.activeRun.id !== run?.id &&
    after.lastRun !== undefined
  )
    events.push({ type: "run.finished", run: after.lastRun });
  if (run !== undefined && before.activeRun?.id !== run.id)
    events.push({ type: "run.started", runId: run.id });
  if (run !== undefined) {
    if (
      run.message !== undefined &&
      JSON.stringify(run.message) !== JSON.stringify(before.activeRun?.message)
    )
      events.push({
        type: "message.updated",
        runId: run.id,
        message: run.message,
      });
    for (const tool of run.tools) {
      const previous = before.activeRun?.tools.find(
        (item) => item.id === tool.id,
      );
      if (previous === undefined)
        events.push({ type: "tool.started", runId: run.id, execution: tool });
      if (
        tool.result !== undefined &&
        JSON.stringify(previous) !== JSON.stringify(tool)
      )
        events.push({
          type: "tool.updated",
          runId: run.id,
          toolCallId: tool.id,
          output:
            tool.type === "exec"
              ? {
                  type: "exec",
                  result: tool.result,
                  calls: tool.calls,
                  approvals: tool.approvals,
                }
              : { type: "tool", result: tool.result },
          status: tool.status,
        });
    }
  }
  return events;
}
