import * as errore from "errore";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { HaloMessage } from "@get-halo/shared/rpc";
import {
  sessionMessages,
  sessionToolExecutions,
  type SessionSnapshot,
  type ToolExecution,
  type ToolIdentity,
} from "@get-halo/shared/sessionState";
import {
  connectionRequestSchema,
  type ConnectionRequest,
} from "@get-halo/shared/ConnectionRequest";

export type SessionViewItem =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistantTurn";
      id: string;
      parts: SessionViewPart[];
    };

export type ToolPart = {
  id: string;
  tool: ToolIdentity;
  args: unknown;
  status: "active" | "completed";
  details: {
    toolPath: string;
    args: unknown;
    resultText?: string;
  };
};

export type SessionViewPart =
  | { kind: "text"; id: string; text: string; streaming: boolean }
  | {
      kind: "toolActivity";
      id: string;
      live: boolean;
      calls: ToolPart[];
    }
  | {
      kind: "executorConnection";
      id: string;
      request: ConnectionRequest;
    };

type ToolActivitySummary = {
  completed: string[];
  current: string | undefined;
};

type ReducedToolInvocation = Pick<
  ToolExecution,
  "id" | "tool" | "arguments" | "result"
> & {
  parentId?: string;
  active: boolean;
};

type ToolActivityPresenter = {
  matches(call: ToolPart): boolean;
  activeLabel(call: ToolPart): string;
  completedSummary(calls: readonly ToolPart[]): string | undefined;
};

type ToolPartLabel = {
  kind: "read" | "wrote" | "shell" | "exec" | "other";
  text: string;
};

type CollectedTool = {
  id: string;
  connectionRequests: ConnectionRequest[];
};

type TextSegment = {
  kind: "text";
  id: string;
  text: string;
  streaming: boolean;
};

type GroupSegment = {
  kind: "group";
  tools: CollectedTool[];
};

type TurnSegment = TextSegment | GroupSegment;

type PendingTurn = {
  id: string;
  segments: TurnSegment[];
};

const connectionDetailsSchema = Type.Object({
  connectionRequests: Type.Array(connectionRequestSchema),
});

const pathArgsSchema = Type.Object({
  path: Type.String(),
});

const bashArgsSchema = Type.Object({
  command: Type.String(),
});

/**
 * Project a session into view rows: one user bubble per user message,
 * one assistant column per stretch of assistant activity (Pi TUI shape).
 * Tool calls on one assistant message are one parallel group. Assistant text
 * splits groups; adjacent tool-only groups stay one activity.
 */
export function sessionViewItems(state: SessionSnapshot): SessionViewItem[] {
  const items: SessionViewItem[] = [];
  const toolResults = toolResultsByCallId(state);
  const invocations = reduceToolInvocations(state);
  const emittedTools = new Set<string>();
  let pending: PendingTurn | undefined;

  function flush(live: boolean) {
    if (pending === undefined) return;
    const parts = projectTurn({
      turn: pending,
      live,
      invocations,
    });
    if (parts.length > 0) {
      items.push({
        kind: "assistantTurn",
        id: pending.id,
        parts,
      });
    }
    pending = undefined;
  }

  function openTurn(id: string): PendingTurn {
    if (pending === undefined) pending = { id, segments: [] };
    return pending;
  }

  function pushAssistantMessage(
    message: HaloMessage,
    streaming: boolean,
    id: string,
  ) {
    if (message.role !== "assistant") return;
    const turn = openTurn(`assistant-${id}`);
    let textIndex = 0;
    for (const part of message.content) {
      if (part.type === "text") {
        if (part.text.length === 0) continue;
        turn.segments.push({
          kind: "text",
          id: `text-${id}-${textIndex}`,
          text: part.text,
          streaming,
        });
        textIndex += 1;
        continue;
      }
      if (part.type !== "toolCall") continue;
      if (emittedTools.has(part.id)) continue;
      emittedTools.add(part.id);
      const toolResult = toolResults.get(part.id);
      const collected: CollectedTool = {
        id: part.id,
        connectionRequests:
          toolResult === undefined ? [] : toolResult.connectionRequests,
      };
      const last = turn.segments.at(-1);
      if (last?.kind === "group") {
        last.tools.push(collected);
        continue;
      }
      turn.segments.push({
        kind: "group",
        tools: [collected],
      });
    }
  }

  for (const entry of state.entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      flush(false);
      items.push({
        kind: "user",
        id: entry.id,
        text: userText(message),
      });
      continue;
    }
    if (message.role === "assistant") {
      pushAssistantMessage(message, false, entry.id);
      if (message.stopReason !== "toolUse") flush(false);
    }
  }

  if (state.activeRun?.message !== undefined) {
    pushAssistantMessage(state.activeRun.message, true, state.activeRun.id);
  }

  flush(state.activeRun !== undefined);

  const last = items.at(-1);
  if (
    state.activeRun !== undefined &&
    (last === undefined || last.kind === "user")
  ) {
    items.push({
      kind: "assistantTurn",
      id: "assistant-working",
      parts: [
        {
          kind: "toolActivity",
          id: "assistant-working-activity",
          live: true,
          calls: [],
        },
      ],
    });
  }

  return items;
}

/** Maui AiChat labels for Pi coding tools. */
export function toolPartLabel(
  part: ToolPart,
  workspaceRoot: string | undefined,
): ToolPartLabel {
  const path = part.tool.path;
  const active = part.status === "active";
  if (path === "exec") {
    return { kind: "exec", text: active ? "Using tools" : "Used tools" };
  }

  const operation = path.split(".").at(-1);
  const fileIntegration = part.tool.integrationId === "files";
  if (isToolSearch(part)) {
    return {
      kind: "other",
      text: active ? "Searching tools" : "Searched tools",
    };
  }
  if (path === "read" || (fileIntegration && operation === "read")) {
    if (!Value.Check(pathArgsSchema, part.args)) {
      return { kind: "other", text: active ? "Reading file" : "Read file" };
    }
    return {
      kind: "read",
      text: `${active ? "Reading" : "Read"} ${stripWorkspaceRootPrefix(part.args.path, workspaceRoot)}`,
    };
  }

  if (
    path === "write" ||
    path === "edit" ||
    path === "patch" ||
    (fileIntegration &&
      operation !== undefined &&
      new Set(["write", "edit", "patch"]).has(operation))
  ) {
    if (!Value.Check(pathArgsSchema, part.args)) {
      return {
        kind: "other",
        text: active ? "Writing file" : "Wrote file",
      };
    }
    return {
      kind: "wrote",
      text: `${active ? "Writing" : "Wrote"} ${stripWorkspaceRootPrefix(part.args.path, workspaceRoot)}`,
    };
  }

  if (path === "bash" || part.tool.integrationId === "bash") {
    if (!Value.Check(bashArgsSchema, part.args)) {
      return {
        kind: "other",
        text: active ? "Running command" : "Ran command",
      };
    }
    return { kind: "shell", text: part.args.command };
  }

  return {
    kind: "other",
    text: `${active ? "Using" : "Used"} ${part.tool.displayName}`,
  };
}

const execArgsSchema = Type.Object({ js: Type.String() });

export function execJsSource(details: ToolPart["details"]): string | undefined {
  if (!Value.Check(execArgsSchema, details.args)) return undefined;
  return details.args.js;
}

function projectTurn(args: {
  turn: PendingTurn;
  live: boolean;
  invocations: readonly ReducedToolInvocation[];
}): SessionViewPart[] {
  const { turn, live, invocations } = args;
  const hasTools = turn.segments.some((segment) => segment.kind === "group");
  const hasText = turn.segments.some((segment) => segment.kind === "text");
  if (!hasTools) {
    if (live && !hasText) {
      return [
        {
          kind: "toolActivity",
          id: `${turn.id}-activity`,
          live: true,
          calls: [],
        },
      ];
    }
    return turn.segments.flatMap((segment) => {
      if (segment.kind !== "text") return [];
      return [
        {
          kind: "text" as const,
          id: segment.id,
          text: segment.text,
          streaming: segment.streaming,
        },
      ];
    });
  }

  const parts: SessionViewPart[] = [];
  let pendingGroups: GroupSegment[] = [];

  function flushGroups(active: boolean) {
    if (pendingGroups.length === 0) return;
    const tools = pendingGroups.flatMap((group) => group.tools);
    const activity = groupActivity({
      tools,
      live: active,
      invocations,
    });
    if (activity !== undefined) parts.push(activity);
    for (const tool of tools) {
      for (const [index, request] of tool.connectionRequests.entries()) {
        parts.push({
          kind: "executorConnection",
          id: `${tool.id}-connection-${index}`,
          request,
        });
      }
    }
    pendingGroups = [];
  }

  for (const segment of turn.segments) {
    if (segment.kind === "text") {
      flushGroups(false);
      parts.push({
        kind: "text",
        id: segment.id,
        text: segment.text,
        streaming: segment.streaming,
      });
      continue;
    }
    pendingGroups.push(segment);
  }
  flushGroups(live);
  return parts;
}

function groupActivity(args: {
  tools: CollectedTool[];
  live: boolean;
  invocations: readonly ReducedToolInvocation[];
}): SessionViewPart | undefined {
  const { tools, live, invocations } = args;
  const firstTool = tools[0];
  if (firstTool === undefined) return undefined;

  const visible = tools.filter((call) => call.connectionRequests.length === 0);
  const activities = activitiesForRoots(
    invocations,
    new Set(visible.map((call) => call.id)),
  );
  const calls = visibleToolParts(activities);

  return {
    kind: "toolActivity",
    id: `tool-${firstTool.id}-activity`,
    live,
    calls,
  };
}

function reduceToolInvocations(
  state: SessionSnapshot,
): ReducedToolInvocation[] {
  return sessionToolExecutions(state).flatMap((tool) => {
    const active = tool.status === "running";
    const root: ReducedToolInvocation = { ...tool, active };
    if (tool.type !== "exec") return [root];
    return [
      root,
      ...tool.calls.map((call) => ({
        id: call.id,
        parentId: call.parentId,
        tool: call.tool,
        arguments: call.arguments,
        active: active && call.status === "running",
      })),
    ];
  });
}

export function summarizeToolActivities(args: {
  calls: readonly ToolPart[];
  workspaceRoot: string | undefined;
  live: boolean;
}): ToolActivitySummary {
  const { calls, workspaceRoot, live } = args;
  const concreteCalls = calls.filter((call) => call.tool.path !== "exec");
  const summarizedCalls = concreteCalls.length === 0 ? calls : concreteCalls;
  const presenters = activityPresenters(workspaceRoot);
  const completed = presenters.flatMap((presenter) => {
    const summary = presenter.completedSummary(summarizedCalls);
    return summary === undefined ? [] : [summary];
  });
  let latestActive: ToolPart | undefined;
  for (let index = summarizedCalls.length - 1; index >= 0; index -= 1) {
    const call = summarizedCalls[index];
    if (call?.status !== "active") continue;
    latestActive = call;
    break;
  }
  const latestActivity = latestActive ?? summarizedCalls.at(-1);
  const presenter =
    latestActivity === undefined
      ? undefined
      : presenters.find((candidate) => candidate.matches(latestActivity));
  const current =
    live && latestActivity !== undefined && presenter !== undefined
      ? presenter.activeLabel(latestActivity)
      : undefined;
  return { completed, current };
}

function visibleToolParts(
  activities: readonly ReducedToolInvocation[],
): ToolPart[] {
  const concreteAncestorIds = new Set<string>();
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  const parts: ToolPart[] = [];
  for (const activity of activities) {
    let detailSource = activity;
    let parentId = activity.parentId;
    while (parentId !== undefined) {
      if (activity.tool.path !== "exec") {
        concreteAncestorIds.add(parentId);
      }
      const parent = byId.get(parentId);
      if (parent?.tool.path === "exec") detailSource = parent;
      parentId = parent?.parentId;
    }
    parts.push(toToolPart({ activity, detailSource }));
  }
  return parts.filter(
    (part) => part.tool.path !== "exec" || !concreteAncestorIds.has(part.id),
  );
}

function activitiesForRoots(
  activities: readonly ReducedToolInvocation[],
  rootIds: ReadonlySet<string>,
): ReducedToolInvocation[] {
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  return activities.filter((activity) => {
    let current: ReducedToolInvocation | undefined = activity;
    while (current !== undefined) {
      if (rootIds.has(current.id)) return true;
      const parentId: string | undefined = current.parentId;
      current = parentId === undefined ? undefined : byId.get(parentId);
    }
    return false;
  });
}

function activityPresenters(
  workspaceRoot: string | undefined,
): ToolActivityPresenter[] {
  return [
    shellPresenter,
    toolSearchPresenter,
    filePresenter("read", workspaceRoot),
    integrationPresenter,
    filePresenter("write", workspaceRoot),
  ];
}

const shellPresenter: ToolActivityPresenter = {
  matches: ({ tool }) => tool.path === "bash" || tool.integrationId === "bash",
  activeLabel: () => "Running command",
  completedSummary: (activities) => {
    const count = completedMatching(activities, shellPresenter).length;
    if (count === 0) return undefined;
    return count === 1 ? "ran 1 command" : `ran ${count} commands`;
  },
};

const toolSearchPresenter: ToolActivityPresenter = {
  matches: isToolSearch,
  activeLabel: () => "Searching tools",
  completedSummary: (calls) =>
    completedMatching(calls, toolSearchPresenter).length === 0
      ? undefined
      : "searched tools",
};

function filePresenter(
  mode: "read" | "write",
  workspaceRoot: string | undefined,
): ToolActivityPresenter {
  const operations =
    mode === "read" ? new Set(["read"]) : new Set(["write", "edit", "patch"]);
  const presenter: ToolActivityPresenter = {
    matches: ({ tool }) => {
      if (operations.has(tool.path)) return true;
      if (tool.integrationId !== "files") return false;
      const operation = tool.path.split(".").at(-1);
      return operation !== undefined && operations.has(operation);
    },
    activeLabel: (call) => {
      const path = callPath(call);
      if (path === undefined)
        return mode === "read" ? "Reading file" : "Writing file";
      const visiblePath = stripWorkspaceRootPrefix(path, workspaceRoot);
      return mode === "read"
        ? `Reading ${visiblePath}`
        : `Writing ${visiblePath}`;
    },
    completedSummary: (activities) => {
      const uniquePaths = new Set<string>();
      let pathless = 0;
      for (const call of completedMatching(activities, presenter)) {
        const path = callPath(call);
        if (path === undefined) {
          pathless += 1;
          continue;
        }
        uniquePaths.add(normalizedPath(path, workspaceRoot));
      }
      const count = uniquePaths.size + pathless;
      if (count === 0) return undefined;
      const verb = mode === "read" ? "read" : "wrote";
      return count === 1 ? `${verb} 1 file` : `${verb} ${count} files`;
    },
  };
  return presenter;
}

const integrationPresenter: ToolActivityPresenter = {
  matches: (call) =>
    call.tool.path === "exec" ||
    (!shellPresenter.matches(call) &&
      !toolSearchPresenter.matches(call) &&
      !isFileActivity(call)),
  activeLabel: ({ tool }) =>
    tool.path === "exec" ? "Using tools" : `Using ${tool.displayName}`,
  completedSummary: (activities) => {
    const labels: string[] = [];
    const seen = new Set<string>();
    for (const call of completedMatching(activities, integrationPresenter)) {
      const identity = stableToolIdentity(call.tool);
      if (seen.has(identity)) continue;
      seen.add(identity);
      labels.push(call.tool.path === "exec" ? "tools" : call.tool.displayName);
    }
    if (labels.length === 0) return undefined;
    return `used ${labels.join(", ")}`;
  },
};

function isToolSearch(call: ToolPart): boolean {
  return (
    call.tool.path === "search" ||
    call.tool.path === "describe.tool" ||
    call.tool.path === "executor.integrations.list"
  );
}

function completedMatching(
  calls: readonly ToolPart[],
  presenter: ToolActivityPresenter,
): ToolPart[] {
  return calls.filter(
    (call) => call.status === "completed" && presenter.matches(call),
  );
}

function isFileActivity(call: ToolPart): boolean {
  const tool = call.tool;
  const path = tool.path;
  return (
    tool.integrationId === "files" ||
    path === "read" ||
    path === "write" ||
    path === "edit" ||
    path === "patch"
  );
}

function callPath(call: ToolPart): string | undefined {
  if (!Value.Check(pathArgsSchema, call.args)) {
    return undefined;
  }
  return call.args.path;
}

function normalizedPath(
  filePath: string,
  workspaceRoot: string | undefined,
): string {
  return toPosixPath(stripWorkspaceRootPrefix(filePath, workspaceRoot)).replace(
    /^\.\//,
    "",
  );
}

function stableToolIdentity(tool: ToolIdentity): string {
  if (tool.integrationId !== undefined) return tool.integrationId;
  return tool.path;
}

function toToolPart(args: {
  activity: ReducedToolInvocation;
  detailSource: ReducedToolInvocation;
}): ToolPart {
  const { activity, detailSource } = args;
  const part: ToolPart = {
    id: activity.id,
    tool: activity.tool,
    args: activity.arguments,
    status: activity.active ? "active" : "completed",
    details: {
      toolPath: detailSource.tool.path,
      args: detailSource.arguments,
    },
  };
  if (detailSource.result !== undefined) {
    const resultText = detailSource.result.content
      .flatMap((content) => (content.type === "text" ? [content.text] : []))
      .join("");
    if (resultText.length > 0) part.details.resultText = resultText;
  }
  return part;
}

function stripWorkspaceRootPrefix(
  filePath: string,
  workspaceRoot: string | undefined,
): string {
  if (workspaceRoot === undefined) return filePath;
  const root = toPosixPath(workspaceRoot).replace(/\/+$/, "");
  const posix = toPosixPath(filePath);
  if (posix === root) return ".";
  if (!posix.startsWith(`${root}/`)) return filePath;
  const relative = posix.slice(root.length + 1);
  if (relative.length === 0) return ".";
  return relative;
}

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function toolResultsByCallId(state: SessionSnapshot) {
  const map = new Map<string, { connectionRequests: ConnectionRequest[] }>();
  for (const entry of state.entries) {
    if (entry.type !== "toolResult") continue;
    const details = entry.output.result.details;
    map.set(entry.toolCallId, {
      connectionRequests: Value.Check(connectionDetailsSchema, details)
        ? details.connectionRequests
        : [],
    });
  }
  return map;
}

function userText(message: HaloMessage): string {
  if (message.role !== "user") return "";
  if (Array.isArray(message.content)) {
    return message.content
      .flatMap((part) => {
        if (part.type !== "text") return [];
        return [part.text];
      })
      .join("");
  }
  return message.content;
}

/** True when the latest user turn ended in a user abort. */
export function lastAssistantTurnWasAborted(messages: HaloMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined) continue;
    if (message.role === "toolResult") continue;
    if (message.role === "user") return false;
    if (message.role === "assistant") return message.stopReason === "aborted";
  }
  return false;
}

/** Readable alert text when an assistant turn failed. */
function assistantTurnError(message: HaloMessage): string | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.stopReason === "aborted") return undefined;

  const errorMessage = message.errorMessage;
  const hasErrorMessage = errorMessage !== undefined && errorMessage.length > 0;
  if (message.stopReason !== "error" && !hasErrorMessage) return undefined;
  if (!hasErrorMessage) return undefined;

  return readableAgentErrorMessage(errorMessage);
}

class AgentErrorMessageParseError extends errore.createTaggedError({
  name: "AgentErrorMessageParseError",
  message: "Assistant errorMessage was not valid JSON",
}) {}

function readableAgentErrorMessage(errorMessage: string): string {
  const trimmed = errorMessage.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return errorMessage;
  }

  const parsed = errore.try({
    try: () => {
      // SAFETY: JSON.parse is untyped; humanMessageFromJson decodes the payload.
      return JSON.parse(trimmed) as unknown;
    },
    catch: (e) => new AgentErrorMessageParseError({ cause: e }),
  });
  if (parsed instanceof Error) {
    console.warn("Assistant errorMessage looked like JSON but failed to parse");
    return errorMessage;
  }

  const extracted = humanMessageFromJson({ value: parsed });
  if (extracted === undefined) return errorMessage;
  return extracted;
}

const agentErrorJsonSchema = Type.Object({
  error: Type.Optional(
    Type.Union([
      Type.String(),
      Type.Object({
        message: Type.String(),
      }),
    ]),
  ),
  message: Type.Optional(Type.String()),
});

function humanMessageFromJson(args: { value: unknown }): string | undefined {
  if (Value.Check(Type.String(), args.value)) {
    const value = args.value;
    const nested = errore.try({
      try: () => {
        // SAFETY: JSON.parse is untyped; nested error JSON is decoded by this function.
        return JSON.parse(value) as unknown;
      },
      catch: (e) => new AgentErrorMessageParseError({ cause: e }),
    });
    if (nested instanceof Error) {
      if (value.length === 0) return undefined;
      return value;
    }
    return humanMessageFromJson({ value: nested });
  }

  if (!Value.Check(agentErrorJsonSchema, args.value)) return undefined;

  const error = args.value.error;
  if (Value.Check(Type.String(), error)) {
    if (error.length === 0) return undefined;
    return error;
  }
  if (
    Value.Check(Type.Object({ message: Type.String({ minLength: 1 }) }), error)
  ) {
    return error.message;
  }

  const message = args.value.message;
  if (message === undefined || message.length === 0) return undefined;
  return message;
}

export function sessionError(state: SessionSnapshot): string | undefined {
  if (state.fault !== undefined) return state.fault;
  if (state.activeRun !== undefined) return undefined;
  const messages = sessionMessages(state);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return undefined;
    if (message.role === "assistant") {
      const error = assistantTurnError(message);
      if (error !== undefined) return error;
      break;
    }
  }
  return state.lastRun?.error;
}
