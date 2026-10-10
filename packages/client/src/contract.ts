import type {
  AutomationGmailConnection,
  AutomationSourceState,
  AutomationWebhookAccess,
  AutomationEvent,
  Automation,
  AutomationInput,
  AutomationRun,
} from "./automations.js";
import type { ServerInfo } from "./protocol.js";
import type { ClientId, RemoteApi } from "@tanishqkancharla/tandem-core";
import type { WorkspaceSchema } from "./database/schema/workspaceSchema.js";
import type { Hotkey, HotkeyInput } from "./hotkeys.js";
import type { ChatPrompt } from "./chatAttachments.js";
import type { WorkspaceFilePreview } from "./rpc.js";
import type { WorkspaceSearchResponse } from "./search.js";
import {
  asyncIteratorObject,
  error,
  oc,
  type,
  type RouterContractClient,
} from "@orpc/contract";
import type { ConnectionRequest } from "./ConnectionRequest.js";
import type { TraceAgent, TraceEvent, TraceOutcome } from "./traces.js";
import type {
  SessionWatchItem,
  SessionSnapshot,
  ToolApprovalDecision,
  ToolIdentity,
  HaloMessage,
} from "./sessionState.js";
import type {
  SessionSummary,
  SessionSummariesUpdate,
  WorkspaceInfo,
  WorkspaceTreeEvent,
} from "./rpc.js";

// Tandem-backed clients use a different workspace stream contract.
export const haloProtocolVersion = 27 as const;
export const haloSupportedProtocols = [25, 26, haloProtocolVersion];

export const RequestRejectedError = error("BAD_REQUEST", {
  message: "Halo could not complete the request.",
  data: type<{ message: string }>(),
});

const publicProcedure = oc.errors({
  [RequestRejectedError.code]: RequestRejectedError,
});

export type ConnectionStarted =
  | { status: "connected" }
  | {
      status: "authorization-required";
      authorizationUrl: string;
      connectionId: string;
      expiresAt: number;
      wasConnected: boolean;
    };

export type ExtensionSummary = {
  id: string;
  url: string;
  displayName: string;
  icon?: string;
};
export type BrowserSnapshot = {
  url: string;
  title: string;
  tree: string;
  errors: string[];
};
export type BrowserExecution = {
  result: unknown;
  stdout: string;
  stderr: string;
  snapshotDiff: string;
  errors: string[];
};

export type WorkspaceUpdate =
  | { type: "hotkeys"; hotkeys: Hotkey[] }
  | { type: "files"; events: WorkspaceTreeEvent[] }
  | { type: "automations"; automations: Automation[] }
  | { type: "extensions"; extensions: ExtensionSummary[] }
  | { type: "extensionsError"; message: string }
  | { type: "sessions"; update: SessionSummariesUpdate };

export const contract = publicProcedure.router({
  sync: {
    connect: oc
      .input(type<{ clientId: ClientId }>())
      .output(
        asyncIteratorObject(
          type<{ type: "ready"; clientId: ClientId } | { type: "poke" }>(),
        ),
      ),
    pull: oc
      .input(type<Parameters<RemoteApi<WorkspaceSchema>["pull"]>[0]>())
      .output(type<Awaited<ReturnType<RemoteApi<WorkspaceSchema>["pull"]>>>()),
  },
  server: {
    info: oc.output(type<ServerInfo>()),
    watch: oc
      .input(
        type<
          | { includeAutomations?: boolean; includeLegacyState?: boolean }
          | undefined
        >(),
      )
      .output(asyncIteratorObject(type<WorkspaceUpdate>())),
  },
  browser: {
    open: oc.input(type<{ url: string }>()).output(
      type<{
        id: string;
        url: string;
        title: string;
        tree: string;
        errors: string[];
      }>(),
    ),
    list: oc.output(type<Array<{ id: string; url: string }>>()),
    exec: oc
      .input(type<{ id: string; source: string }>())
      .output(type<BrowserExecution>()),
    snapshot: oc.input(type<{ id: string }>()).output(type<BrowserSnapshot>()),
    screenshot: oc
      .input(type<{ id: string }>())
      .output(type<{ path: string }>()),
    close: oc.input(type<{ id: string }>()).output(type<void>()),
  },
  extensions: {
    list: oc.output(type<ExtensionSummary[]>()),
    watch: oc.output(asyncIteratorObject(type<ExtensionSummary[]>())),
    reload: oc.output(type<void>()),
    restart: oc.input(type<{ id: string }>()).output(type<void>()),
  },
  workspace: {
    get: oc.output(type<WorkspaceInfo>()),
    listPaths: oc.output(type<string[]>()),
    searchPaths: oc.input(type<{ query: string }>()).output(type<string[]>()),
    watchDirectories: oc
      .input(type<{ paths: string[] }>())
      .output(
        asyncIteratorObject(
          type<{ path: string; entries: string[]; error?: string }>(),
        ),
      ),
    search: oc
      .input(type<{ query: string }>())
      .output(type<WorkspaceSearchResponse>()),
    createEntry: oc
      .input(type<{ path: string; kind: "file" | "directory" }>())
      .output(type<{ path: string }>()),
    moveEntry: oc
      .input(type<{ source: string; destination: string }>())
      .output(type<{ path: string }>()),
    deleteEntry: oc
      .input(type<{ path: string }>())
      .output(type<{ path: string }>()),
    previewFile: oc
      .input(type<{ path: string }>())
      .output(type<WorkspaceFilePreview>()),
    readFile: oc.input(type<{ path: string }>()).output(type<string>()),
    writeFile: oc
      .input(
        type<{ path: string; content: string; expectedContent?: string }>(),
      )
      .output(type<{ path: string; conflict?: boolean }>()),
    reconcileNote: oc
      .input(type<{ path: string; base: string; content: string }>())
      .output(type<{ content: string; expectedContent: string }>()),
    uploadFile: oc
      .input(type<{ path: string; file: File }>())
      .output(type<{ path: string }>()),
    saveImage: oc
      .input(type<{ documentPath: string; file: File; id?: string }>())
      .output(type<{ src: string }>()),
    events: oc.output(asyncIteratorObject(type<WorkspaceTreeEvent[]>())),
  },
  hotkeys: {
    list: oc.output(type<Hotkey[]>()),
    watch: oc.output(asyncIteratorObject(type<Hotkey[]>())),
    save: oc.input(type<HotkeyInput>()).output(type<Hotkey>()),
    remove: oc.input(type<{ id: string }>()).output(type<void>()),
  },
  automations: {
    gmailConnections: oc.output(type<AutomationGmailConnection[]>()),
    webhookAccess: oc
      .input(type<{ automationId: string; rotate?: boolean }>())
      .output(type<AutomationWebhookAccess>()),
    sourceStatus: oc
      .input(type<{ automationId: string }>())
      .output(type<AutomationSourceState>()),
    runNow: oc
      .input(
        type<{
          automationId: string;
          samplePayload?: AutomationEvent["payload"];
        }>(),
      )
      .output(type<AutomationRun>()),
    runScheduled: oc
      .input(type<{ automationId: string }>())
      .output(type<void>()),
    acceptEvent: oc
      .input(type<AutomationEvent>())
      .output(type<AutomationRun>()),
    list: oc.output(type<Automation[]>()),
    watch: oc.output(asyncIteratorObject(type<Automation[]>())),
    save: oc.input(type<AutomationInput>()).output(type<Automation>()),
    remove: oc.input(type<{ automationId: string }>()).output(type<void>()),
    setEnabled: oc
      .input(type<{ automationId: string; enabled: boolean }>())
      .output(type<Automation>()),
    listRuns: oc
      .input(type<{ automationId: string; limit?: number }>())
      .output(type<AutomationRun[]>()),
  },
  thread: {
    list: oc.output(type<SessionSummary[]>()),
    watchSummaries: oc.output(
      asyncIteratorObject(type<SessionSummariesUpdate>()),
    ),
    markRead: oc
      .input(type<{ sessionId: string; observedResultId: string }>())
      .output(type<void>()),
    markUnread: oc.input(type<{ sessionId: string }>()).output(type<void>()),
    markDone: oc.input(type<{ sessionId: string }>()).output(type<void>()),
    markUndone: oc.input(type<{ sessionId: string }>()).output(type<void>()),
    new: oc
      .input(type<{ requestId?: string } | undefined>())
      .output(type<{ sessionId: string }>()),
    snapshot: oc
      .input(type<{ sessionId: string }>())
      .output(type<SessionSnapshot>()),
    events: oc
      .input(type<{ sessionId: string }>())
      .output(asyncIteratorObject(type<SessionWatchItem>())),
    prompt: oc
      .input(type<ChatPrompt & { sessionId: string }>())
      .output(type<{ submissionId: number }>()),
    wait: oc.input(type<{ sessionId: string; submissionId: number }>()).output(
      type<{
        status: "completed" | "aborted" | "failed";
        error?: { message: string };
      }>(),
    ),
    startConnection: oc
      .input(
        type<{
          sessionId: string;
          request: ConnectionRequest;
          // Protocol 24 clients still send completion. OAuth now finishes on
          // the control plane; no provider code is sent to this redirect URI.
          completion?:
            | { kind: "client-loopback"; redirectUri: string }
            | { kind: "server-redirect"; redirectUri: string };
        }>(),
      )
      .output(type<ConnectionStarted>()),
    // An OAuth attempt started on a replaced workspace must be restarted.
    completeOAuth: oc.input(type<{ state: string; code: string }>()),
    cancelConnection:
      oc.input(type<{ sessionId: string; connectionId: string }>()),
    respondToToolApproval:
      oc.input(
        type<{
          sessionId: string;
          approvalId: string;
          decision: ToolApprovalDecision;
        }>(),
      ),
    abort: oc.input(type<{ sessionId: string }>()),
    close: oc.input(type<{ sessionId: string }>()),
  },
  traces: {
    start: oc
      .input(type<{ sessionId: string; agent: TraceAgent; data?: unknown }>())
      .output(type<{ traceId: string; spanId: string }>()),
    record: oc
      .input(type<{ traceId: string; event: TraceEvent }>())
      .output(type<void>()),
    finish: oc
      .input(type<{ traceId: string; outcome: TraceOutcome }>())
      .output(type<void>()),
  },
  testApi: {
    seedSession: oc
      .input(type<{ title: string; messages: HaloMessage[] }>())
      .output(type<{ sessionId: string }>()),
    invokeTool: oc
      .input(type<{ path: string; input: unknown }>())
      .output(type<unknown>()),
    getToolIdentity: oc
      .input(type<{ path: string }>())
      .output(type<ToolIdentity>()),
  },
});

export type HaloClient = RouterContractClient<typeof contract>;
