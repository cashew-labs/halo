import { expect, test } from "vitest";
import {
  applyThreadEvent,
  emptyThreadSnapshot,
  type ExecToolCall,
  type HaloMessage,
  type ThreadEvent,
  type ThreadSnapshot,
} from "@get-halo/client";
import { threadViewItems, summarizeToolActivities } from "./threadView.ts";

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const exec = { path: "exec", displayName: "Exec" };
const gmailGet = {
  path: "gmail.users.messages.get",
  displayName: "Gmail",
  integrationId: "gmail",
};

function toolUse(
  calls: Array<{ id: string; name: string; arguments: Record<string, string> }>,
): HaloMessage & { role: "assistant" } {
  return {
    role: "assistant",
    content: calls.map((call) => ({ type: "toolCall" as const, ...call })),
    api: "google-generative-ai",
    provider: "google-vertex",
    model: "gemini-3-pro-preview",
    usage: emptyUsage,
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function gmailCalls(
  parentId: string,
  count: number,
  status: (index: number) => ExecToolCall["status"],
): ExecToolCall[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${parentId}-get-${String(index)}`,
    parentId,
    tool: gmailGet,
    arguments: { userId: "me", id: `message-${String(index)}` },
    status: status(index),
  }));
}

function apply(snapshot: ThreadSnapshot, events: ThreadEvent[]) {
  return events.reduce(applyThreadEvent, snapshot);
}

function toolActivities(snapshot: ThreadSnapshot) {
  return threadViewItems(snapshot).flatMap((item) =>
    item.kind === "assistantTurn"
      ? item.parts.filter((part) => part.kind === "toolActivity")
      : [],
  );
}

test("projects one stable row per exec while nested calls stream, complete, and fail", () => {
  let snapshot = apply(emptyThreadSnapshot(), [
    { type: "run.started", runId: "run" },
    {
      type: "entry.committed",
      entry: {
        type: "message",
        id: "request",
        message: toolUse([
          { id: "exec-1", name: "exec", arguments: { js: "loop()" } },
        ]),
      },
    },
    {
      type: "tool.started",
      runId: "run",
      execution: {
        type: "exec",
        id: "exec-1",
        tool: exec,
        arguments: { js: "loop()" },
        status: "running",
        calls: [],
        approvals: [],
      },
    },
  ]);
  // Parallel fan-out: 30 nested calls, 12 still running.
  snapshot = apply(snapshot, [
    {
      type: "tool.updated",
      runId: "run",
      toolCallId: "exec-1",
      output: {
        type: "exec",
        result: { content: [] },
        calls: gmailCalls("exec-1", 30, (i) =>
          i < 18 ? "completed" : "running",
        ),
        approvals: [],
      },
      status: "running",
    },
  ]);
  const [streaming] = toolActivities(snapshot);
  expect(streaming?.calls.map((call) => call.id)).toEqual(["exec-1"]);
  expect(streaming?.calls[0]).toMatchObject({ status: "active" });
  expect(streaming?.calls[0]?.calls).toHaveLength(30);
  const live = summarizeToolActivities({
    calls: streaming!.calls,
    workspaceRoot: undefined,
    live: true,
  });
  expect(live.active.map((active) => active.label.text)).toEqual([
    "Using Gmail",
  ]);

  const failedFinish = apply(snapshot, [
    {
      type: "entry.committed",
      entry: {
        type: "toolResult",
        id: "result",
        toolCallId: "exec-1",
        tool: exec,
        timestamp: 2,
        isError: true,
        output: {
          type: "exec",
          result: {
            content: [{ type: "text", text: "Error: quota exceeded" }],
          },
          calls: gmailCalls("exec-1", 31, (i) =>
            i === 30 ? "failed" : "completed",
          ),
          approvals: [],
        },
      },
    },
    { type: "run.finished", run: { id: "run", status: "completed" } },
  ]);
  const [finished] = toolActivities(failedFinish);
  expect(finished?.id).toBe(streaming?.id);
  expect(finished?.live).toBe(false);
  expect(finished?.calls).toHaveLength(1);
  expect(finished?.calls[0]).toMatchObject({
    id: "exec-1",
    status: "completed",
    args: { js: "loop()" },
    resultText: "Error: quota exceeded",
  });
  expect(finished?.calls[0]?.calls[30]).toMatchObject({
    status: "completed",
    args: { userId: "me", id: "message-30" },
  });
  expect(
    summarizeToolActivities({
      calls: finished!.calls,
      workspaceRoot: undefined,
      live: false,
    }),
  ).toEqual({ completed: "Used Gmail", active: [] });
});

test("keeps each top-level exec separate from its siblings and from direct tools", () => {
  const snapshot: ThreadSnapshot = {
    ...emptyThreadSnapshot(),
    entries: [
      {
        type: "message",
        id: "request",
        message: toolUse([
          { id: "exec-a", name: "exec", arguments: { js: "a()" } },
          { id: "bash-1", name: "bash", arguments: { command: "ls" } },
          { id: "exec-b", name: "exec", arguments: { js: "b()" } },
        ]),
      },
    ],
    activeRun: {
      id: "run",
      tools: [
        {
          type: "exec",
          id: "exec-a",
          tool: exec,
          arguments: { js: "a()" },
          status: "running",
          calls: gmailCalls("exec-a", 3, () => "running"),
          approvals: [],
        },
        {
          type: "tool",
          id: "bash-1",
          tool: { path: "bash", displayName: "Shell" },
          arguments: { command: "ls" },
          status: "running",
        },
        {
          type: "exec",
          id: "exec-b",
          tool: exec,
          arguments: { js: "b()" },
          status: "running",
          calls: gmailCalls("exec-b", 5, () => "completed"),
          approvals: [],
        },
      ],
    },
  };

  const [activity] = toolActivities(snapshot);
  expect(
    activity?.calls.map((call) => [call.id, call.calls.length, call.status]),
  ).toEqual([
    ["exec-a", 3, "active"],
    ["bash-1", 0, "active"],
    ["exec-b", 5, "active"],
  ]);
  expect(
    summarizeToolActivities({
      calls: activity!.calls,
      workspaceRoot: undefined,
      live: true,
    }).active.map((active) => active.label.text),
  ).toEqual(["Using Gmail", "ls", "Using Gmail"]);
});
