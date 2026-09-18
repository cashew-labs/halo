import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  connectionRequestKey,
  connectionRequestSchema,
} from "./ConnectionRequest.js";

const textContentSchema = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
  textSignature: Type.Optional(Type.String()),
});

const imageContentSchema = Type.Object({
  type: Type.Literal("image"),
  data: Type.String(),
  mimeType: Type.String(),
});

const thinkingContentSchema = Type.Object({
  type: Type.Literal("thinking"),
  thinking: Type.String(),
  thinkingSignature: Type.Optional(Type.String()),
  redacted: Type.Optional(Type.Boolean()),
});

const jsonValueSchema = Type.Recursive((value) =>
  Type.Union([
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Null(),
    Type.Array(value),
    Type.Record(Type.String(), value),
  ]),
);

const toolCallSchema = Type.Object({
  type: Type.Literal("toolCall"),
  id: Type.String(),
  name: Type.String(),
  arguments: Type.Record(Type.String(), jsonValueSchema),
  thoughtSignature: Type.Optional(Type.String()),
});

const usageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  cacheWrite1h: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Number()),
  totalTokens: Type.Number(),
  cost: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }),
});

const userMessageSchema = Type.Object({
  role: Type.Literal("user"),
  content: Type.Union([
    Type.String(),
    Type.Array(Type.Union([textContentSchema, imageContentSchema])),
  ]),
  timestamp: Type.Number(),
});

const assistantMessageSchema = Type.Object({
  role: Type.Literal("assistant"),
  content: Type.Array(
    Type.Union([textContentSchema, thinkingContentSchema, toolCallSchema]),
  ),
  api: Type.String(),
  provider: Type.String(),
  model: Type.String(),
  responseModel: Type.Optional(Type.String()),
  responseId: Type.Optional(Type.String()),
  usage: usageSchema,
  stopReason: Type.Union([
    Type.Literal("pending"),
    Type.Literal("deferred"),
    Type.Literal("stop"),
    Type.Literal("length"),
    Type.Literal("toolUse"),
    Type.Literal("error"),
    Type.Literal("aborted"),
  ]),
  errorMessage: Type.Optional(Type.String()),
  rawStopReason: Type.Optional(Type.String()),
  timestamp: Type.Number(),
});

const toolResultMessageSchema = Type.Object({
  role: Type.Literal("toolResult"),
  toolCallId: Type.String(),
  toolName: Type.String(),
  content: Type.Array(Type.Union([textContentSchema, imageContentSchema])),
  details: Type.Optional(Type.Unknown()),
  usage: Type.Optional(usageSchema),
  addedToolNames: Type.Optional(Type.Array(Type.String())),
  isError: Type.Boolean(),
  timestamp: Type.Number(),
});

const customMessageContentSchema = Type.Union([
  Type.String(),
  Type.Array(Type.Union([textContentSchema, imageContentSchema])),
]);

export const haloMessageSchema = Type.Union([
  userMessageSchema,
  assistantMessageSchema,
  toolResultMessageSchema,
  Type.Object({
    role: Type.Literal("bashExecution"),
    command: Type.String(),
    output: Type.String(),
    exitCode: Type.Optional(Type.Number()),
    cancelled: Type.Boolean(),
    truncated: Type.Boolean(),
    fullOutputPath: Type.Optional(Type.String()),
    timestamp: Type.Number(),
    excludeFromContext: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    role: Type.Literal("custom"),
    customType: Type.String(),
    content: customMessageContentSchema,
    display: Type.Boolean(),
    details: Type.Optional(Type.Unknown()),
    timestamp: Type.Number(),
  }),
  Type.Object({
    role: Type.Literal("branchSummary"),
    summary: Type.String(),
    fromId: Type.Union([Type.String(), Type.Null()]),
    timestamp: Type.Number(),
  }),
  Type.Object({
    role: Type.Literal("compactionSummary"),
    summary: Type.String(),
    tokensBefore: Type.Number(),
    timestamp: Type.Number(),
  }),
]);

export type HaloMessage = Static<typeof haloMessageSchema>;

const toolIdentitySchema = Type.Object({
  path: Type.String(),
  displayName: Type.String(),
  integrationId: Type.Optional(Type.String()),
});

export type ToolIdentity = Static<typeof toolIdentitySchema>;

export const toolApprovalSchema = Type.Object({
  id: Type.String(),
  toolPath: Type.String(),
  message: Type.String(),
  arguments: Type.Unknown(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("allowed"),
    Type.Literal("denied"),
    Type.Literal("cancelled"),
  ]),
});

export type ToolApproval = Static<typeof toolApprovalSchema>;
export type ToolApprovalDecision = "allow" | "deny";
export const toolApprovalDecisionCustomType = "halo.tool.approval.decision";

const toolApprovalDecisionDetailsSchema = Type.Object({
  approvalId: Type.String(),
  decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
});

export const execToolCallSchema = Type.Object({
  id: Type.String(),
  parentId: Type.String(),
  tool: toolIdentitySchema,
  arguments: Type.Unknown(),
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ]),
});
export type ExecToolCall = Static<typeof execToolCallSchema>;
export function directToolIdentity(name: string): ToolIdentity {
  const labels = new Map([
    ["bash", "Shell"],
    ["edit", "Edit"],
    ["exec", "Exec"],
    ["patch", "Patch"],
    ["read", "Read"],
    ["viewImage", "View image"],
    ["write", "Write"],
  ]);
  const label = labels.get(name);
  return { path: name, displayName: label === undefined ? name : label };
}

const haloConnectionEventSchema = Type.Union([
  Type.Object({
    type: Type.Literal("halo.connection"),
    connectionId: Type.String(),
    request: connectionRequestSchema,
    status: Type.Literal("connecting"),
    expiresAt: Type.Number(),
    wasConnected: Type.Boolean(),
  }),
  Type.Object({
    type: Type.Literal("halo.connection"),
    connectionId: Type.String(),
    request: connectionRequestSchema,
    status: Type.Union([
      Type.Literal("connected"),
      Type.Literal("cancelled"),
      Type.Literal("expired"),
    ]),
  }),
]);

export type HaloConnectionEvent = Static<typeof haloConnectionEventSchema>;
type WithoutEventType<T> = T extends { type: string } ? Omit<T, "type"> : never;
export type HaloConnectionState = WithoutEventType<HaloConnectionEvent>;

const toolResultSchema = Type.Object({
  content: Type.Array(Type.Union([textContentSchema, imageContentSchema])),
  details: Type.Optional(Type.Unknown()),
  usage: Type.Optional(usageSchema),
  addedToolNames: Type.Optional(Type.Array(Type.String())),
  terminate: Type.Optional(Type.Boolean()),
});

export type ToolResult = Static<typeof toolResultSchema>;

export type ToolOutput =
  | { type: "tool"; result: ToolResult }
  | {
      type: "exec";
      result: ToolResult;
      calls: ExecToolCall[];
      approvals: ToolApproval[];
    };

export type ToolExecution = {
  id: string;
  tool: ToolIdentity;
  arguments: unknown;
  status: "running" | "completed" | "failed" | "aborted";
} & (
  | { type: "tool"; result?: ToolResult }
  | {
      type: "exec";
      result?: ToolResult;
      calls: ExecToolCall[];
      approvals: ToolApproval[];
    }
);

export type HaloEntry =
  | {
      type: "message";
      id: string;
      message: Exclude<HaloMessage, { role: "toolResult" }>;
    }
  | {
      type: "toolResult";
      id: string;
      toolCallId: string;
      tool: ToolIdentity;
      timestamp: number;
      isError: boolean;
      output: ToolOutput;
    };

export type ActiveRun = {
  id: string;
  message?: Extract<HaloMessage, { role: "assistant" }>;
  tools: ToolExecution[];
};

export type RunResult = {
  id: string;
  status: "completed" | "aborted" | "failed" | "declined";
  error?: string;
};

export type SessionSnapshot = {
  entries: HaloEntry[];
  activeRun: ActiveRun | undefined;
  lastRun: RunResult | undefined;
  fault: string | undefined;
  connections: HaloConnectionState[];
};

export type SessionEvent =
  | { type: "session.failed"; error: string }
  | { type: "run.started"; runId: string }
  | { type: "run.finished"; run: RunResult }
  | { type: "entry.committed"; entry: HaloEntry }
  | {
      type: "message.updated";
      runId: string;
      message: Extract<HaloMessage, { role: "assistant" }>;
    }
  | { type: "tool.started"; runId: string; execution: ToolExecution }
  | {
      type: "tool.updated";
      runId: string;
      toolCallId: string;
      output: ToolOutput;
      status: ToolExecution["status"];
    }
  | HaloConnectionEvent;

export type SessionWatchItem =
  | { type: "snapshot"; snapshot: SessionSnapshot }
  | { type: "event"; event: SessionEvent };

export function emptySessionSnapshot(): SessionSnapshot {
  return {
    entries: [],
    activeRun: undefined,
    lastRun: undefined,
    fault: undefined,
    connections: [],
  };
}

export function reduceSessionUpdate(
  snapshot: SessionSnapshot,
  item: SessionWatchItem,
): SessionSnapshot {
  if (item.type === "snapshot") return item.snapshot;
  return applySessionEvent(snapshot, item.event);
}

export function applySessionEvent(
  snapshot: SessionSnapshot,
  event: SessionEvent,
): SessionSnapshot {
  switch (event.type) {
    case "session.failed":
      return { ...snapshot, fault: event.error, activeRun: undefined };
    case "run.started":
      return { ...snapshot, activeRun: { id: event.runId, tools: [] } };
    case "run.finished":
      if (event.run.id !== snapshot.activeRun?.id) return snapshot;
      return { ...snapshot, activeRun: undefined, lastRun: event.run };
    case "entry.committed": {
      const entry = event.entry;
      let activeRun = snapshot.activeRun;
      if (activeRun !== undefined) {
        if (entry.type === "message" && entry.message.role === "assistant")
          activeRun = { ...activeRun, message: undefined };
        if (entry.type === "toolResult")
          activeRun = {
            ...activeRun,
            tools: activeRun.tools.filter(
              (tool) => tool.id !== entry.toolCallId,
            ),
          };
      }
      return { ...snapshot, entries: [...snapshot.entries, entry], activeRun };
    }
    case "message.updated":
      if (snapshot.activeRun?.id !== event.runId) return snapshot;
      return {
        ...snapshot,
        activeRun: { ...snapshot.activeRun, message: event.message },
      };
    case "tool.started":
      if (snapshot.activeRun?.id !== event.runId) return snapshot;
      return {
        ...snapshot,
        activeRun: {
          ...snapshot.activeRun,
          tools: [...snapshot.activeRun.tools, event.execution],
        },
      };
    case "tool.updated":
      if (snapshot.activeRun?.id !== event.runId) return snapshot;
      return {
        ...snapshot,
        activeRun: {
          ...snapshot.activeRun,
          tools: snapshot.activeRun.tools.map((tool) =>
            tool.id === event.toolCallId
              ? executionWithOutput(tool, event.output, event.status)
              : tool,
          ),
        },
      };
    case "halo.connection":
      return {
        ...snapshot,
        connections: applyConnectionEvent(snapshot.connections, event),
      };
  }
}

export function applyConnectionEvent(
  states: readonly HaloConnectionState[],
  event: HaloConnectionEvent,
): HaloConnectionState[] {
  const current = states.find(
    (state) =>
      connectionRequestKey(state.request) ===
      connectionRequestKey(event.request),
  );
  const state = connectionStateFromEvent(current, event);
  return [
    ...states.filter(
      (candidate) =>
        connectionRequestKey(candidate.request) !==
        connectionRequestKey(event.request),
    ),
    state,
  ];
}

function connectionStateFromEvent(
  current: HaloConnectionState | undefined,
  event: HaloConnectionEvent,
): HaloConnectionState {
  const { type: _type, ...next } = event;
  if (
    event.status !== "connecting" &&
    event.status !== "connected" &&
    current?.status === "connecting" &&
    current.connectionId === event.connectionId &&
    current.wasConnected
  ) {
    return {
      connectionId: event.connectionId,
      request: event.request,
      status: "connected",
    };
  }
  return next;
}

export function executionWithOutput(
  execution: ToolExecution,
  output: ToolOutput,
  status: ToolExecution["status"],
): ToolExecution {
  return { ...execution, ...output, status };
}

/** Read committed messages without tool-result entries. */
export function sessionMessages(snapshot: SessionSnapshot) {
  return snapshot.entries.flatMap((entry) =>
    entry.type === "message" ? [entry.message] : [],
  );
}

/** Assemble tool executions from committed entries and the current run. */
export function sessionToolExecutions(
  snapshot: SessionSnapshot,
): ToolExecution[] {
  const requests = new Map<string, ToolExecution["arguments"]>();
  const executions = new Map<string, ToolExecution>();
  for (const entry of snapshot.entries) {
    if (entry.type === "message") {
      if (entry.message.role !== "assistant") continue;
      for (const part of entry.message.content) {
        if (part.type === "toolCall") requests.set(part.id, part.arguments);
      }
      continue;
    }
    const request = requests.get(entry.toolCallId);
    executions.set(entry.toolCallId, {
      id: entry.toolCallId,
      tool: entry.tool,
      arguments: request,
      status: entry.isError ? "failed" : "completed",
      ...entry.output,
    });
  }
  if (snapshot.activeRun !== undefined)
    for (const tool of snapshot.activeRun.tools) executions.set(tool.id, tool);
  const decisions = toolApprovalDecisions(snapshot);
  return [...executions.values()].map((execution) => {
    if (execution.type !== "exec") return execution;
    return {
      ...execution,
      approvals: execution.approvals.map((approval) => {
        const decision = decisions.get(approval.id);
        if (decision === undefined) return approval;
        return {
          ...approval,
          status: decision === "allow" ? "allowed" : "denied",
        };
      }),
    };
  });
}

function toolApprovalDecisions(snapshot: SessionSnapshot) {
  const decisions = new Map<string, ToolApprovalDecision>();
  for (const entry of snapshot.entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "custom") continue;
    if (message.customType !== toolApprovalDecisionCustomType) continue;
    if (!Value.Check(toolApprovalDecisionDetailsSchema, message.details))
      continue;
    decisions.set(message.details.approvalId, message.details.decision);
  }
  return decisions;
}
