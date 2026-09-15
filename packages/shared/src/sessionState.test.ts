import { expect, test } from "vitest";
import {
  applySessionEvent,
  emptySessionSnapshot,
  reduceSessionUpdate,
  sessionMessages,
  sessionToolExecutions,
  type HaloEntry,
  type HaloMessage,
  type SessionSnapshot,
  type ToolExecution,
} from "./sessionState.js";

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

test("exposes exec's nested calls during execution and from its committed result", () => {
  const request = assistantMessage({
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        id: "exec-1",
        name: "exec",
        arguments: { js: "await tools.read()" },
      },
    ],
  });
  let snapshot: SessionSnapshot = {
    ...emptySessionSnapshot(),
    entries: [{ type: "message", id: "request-1", message: request }],
  };
  snapshot = applySessionEvent(snapshot, {
    type: "run.started",
    runId: "run-1",
  });
  const execution: ToolExecution = {
    type: "exec",
    id: "exec-1",
    tool: { path: "exec", displayName: "Exec" },
    arguments: { js: "await tools.read()" },
    status: "running",
    calls: [],
  };
  snapshot = applySessionEvent(snapshot, {
    type: "tool.started",
    runId: "run-1",
    execution,
  });
  const call = {
    id: "read-1",
    parentId: "exec-1",
    tool: { path: "files.read", displayName: "Files" },
    arguments: { path: "notes.md" },
    status: "running" as const,
  };
  snapshot = applySessionEvent(snapshot, {
    type: "tool.updated",
    runId: "run-1",
    toolCallId: "exec-1",
    status: "running",
    output: { type: "exec", result: { content: [] }, calls: [call] },
  });
  expect(sessionToolExecutions(snapshot)).toMatchObject([
    { type: "exec", status: "running", calls: [call] },
  ]);
  const during = snapshot;
  const entry: HaloEntry = {
    type: "toolResult",
    id: "result-1",
    toolCallId: "exec-1",
    tool: execution.tool,
    timestamp: 3,
    isError: false,
    output: {
      type: "exec",
      result: { content: [{ type: "text", text: "Read notes" }] },
      calls: [{ ...call, status: "completed" }],
    },
  };
  snapshot = applySessionEvent(snapshot, { type: "entry.committed", entry });
  expect(snapshot.activeRun?.tools).toEqual([]);
  expect(sessionToolExecutions(snapshot)).toEqual([
    {
      ...execution,
      status: "completed",
      result: entry.output.result,
      calls: [{ ...call, status: "completed" }],
    },
  ]);
  const reopened = reduceSessionUpdate(during, { type: "snapshot", snapshot });
  expect(sessionToolExecutions(reopened)).toEqual(
    sessionToolExecutions(snapshot),
  );
  expect(sessionToolExecutions(during)).toMatchObject([
    { calls: [{ status: "running" }] },
  ]);
});

test("replaces a previous session and continues the snapshot's active run", () => {
  const previous: SessionSnapshot = {
    ...emptySessionSnapshot(),
    entries: [
      {
        type: "message",
        id: "old",
        message: userMessage("Previous session", 1),
      },
    ],
  };
  const current: SessionSnapshot = {
    ...emptySessionSnapshot(),
    entries: [
      {
        type: "message",
        id: "current",
        message: userMessage("Current session", 2),
      },
    ],
    activeRun: { id: "run-2", tools: [] },
  };
  const restored = reduceSessionUpdate(previous, {
    type: "snapshot",
    snapshot: current,
  });
  const completed = reduceSessionUpdate(restored, {
    type: "event",
    event: { type: "run.finished", run: { id: "run-2", status: "completed" } },
  });
  expect(completed.entries).toEqual(current.entries);
  expect(completed.activeRun).toBeUndefined();
  expect(previous.entries[0]?.id).toBe("old");
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

test("restores connection progress from session state", () => {
  const request = {
    client: "first-party:google",
    clientOwner: "org" as const,
    owner: "user" as const,
    connectionName: "default",
    integration: "google_drive",
    template: "googleOAuth2",
  };
  let snapshot = applySessionEvent(emptySessionSnapshot(), {
    type: "halo.connection",
    connectionId: "connection-1",
    request,
    status: "connecting",
    expiresAt: 10_000,
    wasConnected: false,
  });
  expect(snapshot.connections).toEqual([
    {
      connectionId: "connection-1",
      request,
      status: "connecting",
      expiresAt: 10_000,
      wasConnected: false,
    },
  ]);

  snapshot = applySessionEvent(snapshot, {
    type: "halo.connection",
    connectionId: "connection-1",
    request,
    status: "connected",
  });
  expect(snapshot.connections).toMatchObject([
    { connectionId: "connection-1", request, status: "connected" },
  ]);
});

test("keeps an existing connection when reconnect authorization is cancelled", () => {
  const request = {
    client: "first-party:google",
    clientOwner: "org" as const,
    owner: "user" as const,
    connectionName: "default",
    integration: "google_drive",
    template: "googleOAuth2",
  };
  let snapshot = applySessionEvent(emptySessionSnapshot(), {
    type: "halo.connection",
    connectionId: "connection-1",
    request,
    status: "connecting",
    expiresAt: 10_000,
    wasConnected: true,
  });
  snapshot = applySessionEvent(snapshot, {
    type: "halo.connection",
    connectionId: "connection-1",
    request,
    status: "cancelled",
  });
  expect(snapshot.connections).toMatchObject([
    { connectionId: "connection-1", request, status: "connected" },
  ]);
});
