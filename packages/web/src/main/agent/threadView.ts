import * as errore from "errore";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  type HaloMessage,
  threadMessages,
  threadToolExecutions,
  userInterruptionCustomType,
  type ThreadSnapshot,
  type ToolExecution,
  type ToolApproval,
  type ToolIdentity,
  connectionRequestSchema,
  type ConnectionRequest,
  type ChatAttachment,
  type ChatReference,
  connectionRequestKey,
} from "@get-halo/client";

export type ThreadViewItem =
  | { kind: "interruption"; id: string }
  | {
      kind: "user";
      id: string;
      text: string;
      attachments: Array<
        Pick<ChatAttachment, "name"> & Partial<Pick<ChatAttachment, "path">>
      >;
      references: ChatReference[];
      pending?: true;
    }
  | {
      kind: "bashExecution";
      id: string;
      message: Extract<HaloMessage, { role: "bashExecution" }>;
    }
  | {
      kind: "assistantTurn";
      id: string;
      parts: ThreadViewPart[];
    };

/** One top-level tool invocation; exec keeps its nested invocations in `calls`. */
export type ToolPart = {
  id: string;
  tool: ToolIdentity;
  args: unknown;
  status: "active" | "completed";
  resultText?: string;
  calls: ToolPart[];
};

export type ThreadViewPart =
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
    }
  | {
      kind: "toolApproval";
      id: string;
      approval: ToolApproval;
    };

type ToolActivitySummary = {
  completed: string | undefined;
  active: Array<{ id: string; label: ToolPartLabel }>;
};

type ToolActivityPresenter = {
  matches(call: ToolPart): boolean;
  completedSummary(calls: readonly ToolPart[]): string | undefined;
};

type ToolPartLabel = {
  kind: "read" | "wrote" | "shell" | "exec" | "other";
  text: string;
};

type CollectedTool = {
  id: string;
  connectionRequests: ConnectionRequest[];
  approvals: ToolApproval[];
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
 * Project a thread into view rows: one user bubble per user message,
 * one assistant column per stretch of assistant activity (Pi TUI shape).
 * Tool calls on one assistant message are one parallel group. Assistant text
 * splits groups; adjacent tool-only groups stay one activity.
 */
export function threadViewItems(state: ThreadSnapshot): ThreadViewItem[] {
  const items: ThreadViewItem[] = [];
  const toolResults = toolResultsByCallId(state);
  const toolApprovals = toolApprovalsByCallId(state);
  const executions = new Map(
    threadToolExecutions(state).map((execution) => [execution.id, execution]),
  );
  const emittedTools = new Set<string>();
  let pending: PendingTurn | undefined;

  function flush(live: boolean) {
    if (pending === undefined) return;
    const parts = projectTurn({
      turn: pending,
      live,
      executions,
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
      const approvals = toolApprovals.get(part.id);
      const collected: CollectedTool = {
        id: part.id,
        connectionRequests:
          toolResult === undefined ? [] : toolResult.connectionRequests,
        approvals: approvals === undefined ? [] : approvals,
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
    if (
      message.role === "custom" &&
      message.customType === userInterruptionCustomType
    ) {
      flush(false);
      items.push({ kind: "interruption", id: entry.id });
      continue;
    }
    if (message.role === "user") {
      flush(false);
      items.push({
        kind: "user",
        id: entry.id,
        text: userText(message),
        attachments: message.attachments ?? [],
        references: message.references ?? [],
      });
      continue;
    }
    if (message.role === "bashExecution") {
      flush(false);
      items.push({ kind: "bashExecution", id: entry.id, message });
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
    if (active) {
      // The latest nested call describes the current work, including the gap
      // between sequential calls.
      const latest =
        part.calls.filter((call) => call.status === "active").at(-1) ??
        part.calls.at(-1);
      if (latest === undefined) return { kind: "exec", text: "Using tools" };
      return toolPartLabel({ ...latest, status: "active" }, workspaceRoot);
    }
    return {
      kind: "exec",
      text: completedSummary(part.calls, workspaceRoot) ?? "Used tools",
    };
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
    const command = bashCommand(part);
    if (command === undefined) {
      return {
        kind: "other",
        text: active ? "Running command" : "Ran command",
      };
    }
    return { kind: "shell", text: command };
  }

  return {
    kind: "other",
    text: `${active ? "Using" : "Used"} ${part.tool.displayName}`,
  };
}

const execArgsSchema = Type.Object({ js: Type.String() });

export function execJsSource(part: ToolPart): string | undefined {
  if (part.tool.path !== "exec") return undefined;
  if (!Value.Check(execArgsSchema, part.args)) return undefined;
  return part.args.js;
}

function projectTurn(args: {
  turn: PendingTurn;
  live: boolean;
  executions: ReadonlyMap<string, ToolExecution>;
}): ThreadViewPart[] {
  const { turn, live, executions } = args;
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

  const parts: ThreadViewPart[] = [];
  let pendingGroups: GroupSegment[] = [];
  const connectionRequests = new Set<string>();

  function flushGroups(active: boolean) {
    if (pendingGroups.length === 0) return;
    const tools = pendingGroups.flatMap((group) => group.tools);
    const activity = groupActivity({
      tools,
      live: active,
      executions,
    });
    if (activity !== undefined) parts.push(activity);
    for (const tool of tools) {
      for (const approval of tool.approvals) {
        parts.push({
          kind: "toolApproval",
          id: approval.id,
          approval,
        });
      }
      for (const [index, request] of tool.connectionRequests.entries()) {
        const key = connectionRequestKey(request);
        if (connectionRequests.has(key)) continue;
        connectionRequests.add(key);
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
  executions: ReadonlyMap<string, ToolExecution>;
}): ThreadViewPart | undefined {
  const { tools, live, executions } = args;
  const firstTool = tools[0];
  if (firstTool === undefined) return undefined;

  const calls = tools.flatMap((tool) => {
    if (tool.connectionRequests.length > 0) return [];
    const execution = executions.get(tool.id);
    return execution === undefined ? [] : [toToolPart(execution)];
  });

  return {
    kind: "toolActivity",
    id: `tool-${firstTool.id}-activity`,
    live,
    calls,
  };
}

/**
 * Summarize top-level calls for one status line. Completed text describes the
 * concrete tools used, including calls nested in exec; active labels stay one
 * per top-level call so nested fan-out never multiplies the status.
 */
export function summarizeToolActivities(args: {
  calls: readonly ToolPart[];
  workspaceRoot: string | undefined;
  live: boolean;
}): ToolActivitySummary {
  const { calls, workspaceRoot, live } = args;
  const active = live
    ? calls.flatMap((call) =>
        call.status === "active"
          ? [{ id: call.id, label: toolPartLabel(call, workspaceRoot) }]
          : [],
      )
    : [];
  return { completed: completedSummary(calls, workspaceRoot), active };
}

function completedSummary(
  calls: readonly ToolPart[],
  workspaceRoot: string | undefined,
): string | undefined {
  const concreteCalls = calls.flatMap((call) =>
    call.tool.path === "exec" ? call.calls : [call],
  );
  const summarizedCalls = concreteCalls.length === 0 ? calls : concreteCalls;
  const chunks = activityPresenters(workspaceRoot).flatMap((presenter) => {
    const summary = presenter.completedSummary(summarizedCalls);
    return summary === undefined ? [] : [summary];
  });
  return joinSummary(chunks);
}

function joinSummary(chunks: readonly string[]): string | undefined {
  const first = chunks[0];
  if (first === undefined) return undefined;
  const capitalized = `${first.charAt(0).toUpperCase()}${first.slice(1)}`;
  const rest = chunks.slice(1);
  const last = rest.at(-1);
  if (last === undefined) return capitalized;
  if (rest.length === 1) return `${capitalized} and ${last}`;
  return `${capitalized}, ${rest.slice(0, -1).join(", ")}, and ${last}`;
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
  completedSummary: (activities) => {
    const count = completedMatching(activities, shellPresenter).length;
    if (count === 0) return undefined;
    return count === 1 ? "ran 1 command" : `ran ${count} commands`;
  },
};

const toolSearchPresenter: ToolActivityPresenter = {
  matches: isToolSearch,
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

function bashCommand(call: ToolPart): string | undefined {
  if (!Value.Check(bashArgsSchema, call.args)) {
    return undefined;
  }
  return call.args.command;
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

function toToolPart(execution: ToolExecution): ToolPart {
  const active = execution.status === "running";
  const part: ToolPart = {
    id: execution.id,
    tool: execution.tool,
    args: execution.arguments,
    status: active ? "active" : "completed",
    calls:
      execution.type === "exec"
        ? execution.calls.map((call) => ({
            id: call.id,
            tool: call.tool,
            args: call.arguments,
            status:
              active && call.status === "running" ? "active" : "completed",
            calls: [],
          }))
        : [],
  };
  const resultText = execution.result?.content
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("");
  if (resultText !== undefined && resultText.length > 0)
    part.resultText = resultText;
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

function toolResultsByCallId(state: ThreadSnapshot) {
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

function toolApprovalsByCallId(state: ThreadSnapshot) {
  const approvals = new Map<string, ToolApproval[]>();
  for (const execution of threadToolExecutions(state)) {
    if (execution.type !== "exec") continue;
    approvals.set(execution.id, execution.approvals);
  }
  return approvals;
}

function userText(message: HaloMessage): string {
  if (message.role !== "user") return "";
  if (message.displayText !== undefined) return message.displayText;
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

export function threadError(state: ThreadSnapshot): string | undefined {
  if (state.fault !== undefined) return state.fault;
  if (state.activeRun !== undefined) return undefined;
  if (state.lastRun?.status === "aborted") return undefined;
  const messages = threadMessages(state);
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
