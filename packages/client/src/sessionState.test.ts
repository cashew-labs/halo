import { expect, test } from "vitest";
import {
  applySessionEvent,
  emptySessionSnapshot,
  sessionMessages,
  sessionToolExecutions,
  toolApprovalDecisionCustomType,
  type HaloEntry,
  type HaloMessage,
  type SessionSnapshot,
} from "@get-halo/client";

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function assistantMessage(
  overrides: Partial<Extract<HaloMessage, { role: "assistant" }>> &
    Pick<Extract<HaloMessage, { role: "assistant" }>, "stopReason">,
): Extract<HaloMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [],
    api: "google-generative-ai",
    provider: "google-vertex",
    model: "gemini-3-pro-preview",
    usage: emptyUsage,
    timestamp: 1,
    ...overrides,
  };
}

function userMessage(
  text: string,
  timestamp: number,
): Extract<HaloMessage, { role: "user" }> {
  return {
    role: "user",
    content: text,
    timestamp,
  };
}

test("follows a partial response through its committed entry and completed run", () => {
  let snapshot = emptySessionSnapshot();
  snapshot = applySessionEvent(snapshot, {
    type: "run.started",
    runId: "run-1",
  });
  const user: HaloEntry = {
    type: "message",
    id: "user-1",
    message: userMessage("Hello", 1),
  };
  snapshot = applySessionEvent(snapshot, {
    type: "entry.committed",
    entry: user,
  });
  const partial = assistantMessage({
    content: [{ type: "text", text: "Hello" }],
    stopReason: "pending",
  });
  snapshot = applySessionEvent(snapshot, {
    type: "message.updated",
    runId: "run-1",
    message: partial,
  });
  const during = snapshot;
  expect(sessionMessages(during)).toEqual([user.message]);
  expect(during.activeRun?.message).toEqual(partial);

  const reply: HaloEntry = {
    type: "message",
    id: "reply-1",
    message: { ...partial, stopReason: "stop" },
  };
  snapshot = applySessionEvent(snapshot, {
    type: "entry.committed",
    entry: reply,
  });
  expect(snapshot.activeRun?.message).toBeUndefined();
  snapshot = applySessionEvent(snapshot, {
    type: "run.finished",
    run: { id: "run-1", status: "completed" },
  });
  expect(snapshot.entries).toEqual([user, reply]);
  expect(snapshot.activeRun).toBeUndefined();
  expect(snapshot.lastRun).toEqual({ id: "run-1", status: "completed" });
  expect(during.activeRun?.message).toEqual(partial);
});

test("overlays persisted tool approval decisions", () => {
  const request = assistantMessage({
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        id: "exec-approval",
        name: "exec",
        arguments: { js: "return await tools.example.create({ id: 1 })" },
      },
    ],
  });
  const snapshot: SessionSnapshot = {
    ...emptySessionSnapshot(),
    entries: [
      { type: "message", id: "request", message: request },
      {
        type: "toolResult",
        id: "approval-result",
        toolCallId: "exec-approval",
        tool: { path: "exec", displayName: "Exec" },
        timestamp: 2,
        isError: false,
        output: {
          type: "exec",
          result: { content: [] },
          calls: [],
          approvals: [
            {
              id: "approval-1",
              toolPath: "example.create",
              message: "Create example",
              arguments: { id: 1 },
              status: "pending",
            },
          ],
        },
      },
      {
        type: "message",
        id: "decision",
        message: {
          role: "custom",
          customType: toolApprovalDecisionCustomType,
          content: "Approved",
          display: false,
          details: { approvalId: "approval-1", decision: "allow" },
          timestamp: 3,
        },
      },
    ],
  };

  expect(sessionToolExecutions(snapshot)[0]).toMatchObject({
    type: "exec",
    approvals: [{ id: "approval-1", status: "allowed" }],
  });
});

test("keeps model-call order while parallel tools complete out of order", () => {
  const calls = ["slow", "fast", "not-started"].map((id) => ({
    type: "toolCall" as const,
    id,
    name: "read",
    arguments: { path: `${id}.txt` },
  }));
  let snapshot: SessionSnapshot = {
    ...emptySessionSnapshot(),
    entries: [
      {
        type: "message",
        id: "request",
        message: assistantMessage({ stopReason: "toolUse", content: calls }),
      },
    ],
    activeRun: {
      id: "run",
      tools: [
        {
          type: "tool",
          id: "slow",
          tool: { path: "read", displayName: "Read" },
          arguments: { path: "slow.txt" },
          status: "running",
        },
      ],
    },
  };
  for (const id of ["fast", "slow"]) {
    snapshot = applySessionEvent(snapshot, {
      type: "entry.committed",
      entry: {
        type: "toolResult",
        id: `result-${id}`,
        toolCallId: id,
        tool: { path: "read", displayName: "Read" },
        timestamp: 1,
        isError: false,
        output: { type: "tool", result: { content: [] } },
      },
    });
    expect(sessionToolExecutions(snapshot).map((tool) => tool.id)).toEqual([
      "slow",
      "fast",
    ]);
  }
  expect(sessionToolExecutions(snapshot).map((tool) => tool.status)).toEqual([
    "completed",
    "completed",
  ]);
});

test("keeps run outcomes without allowing late updates to replace a newer run", () => {
  let snapshot = applySessionEvent(emptySessionSnapshot(), {
    type: "run.started",
    runId: "failed-run",
  });
  snapshot = applySessionEvent(snapshot, {
    type: "run.finished",
    run: { id: "failed-run", status: "failed", error: "Access denied" },
  });
  expect(snapshot.lastRun).toEqual({
    id: "failed-run",
    status: "failed",
    error: "Access denied",
  });
  snapshot = applySessionEvent(snapshot, {
    type: "run.started",
    runId: "retry",
  });
  const late = applySessionEvent(snapshot, {
    type: "message.updated",
    runId: "failed-run",
    message: assistantMessage({ stopReason: "pending" }),
  });
  expect(late.activeRun).toEqual({ id: "retry", tools: [] });
  const aborted = applySessionEvent(late, {
    type: "run.finished",
    run: { id: "retry", status: "aborted" },
  });
  expect(aborted.lastRun).toEqual({ id: "retry", status: "aborted" });
  expect(aborted.activeRun).toBeUndefined();
});
