import type { WorkspaceFilePreview, HaloMessage } from "./rpc.js";
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
  ToolIdentity,
} from "./sessionState.js";
import type {
  SessionSummary,
  WorkspaceInfo,
  WorkspaceTreeEvent,
} from "./rpc.js";

export const haloProtocolVersion = 11 as const;

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

export type OAuthCompletion =
  | { kind: "client-loopback"; redirectUri: string }
  | { kind: "server-redirect"; redirectUri: string };

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

export const contract = publicProcedure.router({
  server: {
    info: oc.output(type<{ protocolVersion: typeof haloProtocolVersion }>()),
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
    reload: oc.output(type<void>()),
    restart: oc.input(type<{ id: string }>()).output(type<void>()),
  },
  workspace: {
    get: oc.output(type<WorkspaceInfo>()),
    listPaths: oc.output(type<string[]>()),
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
      .input(type<{ path: string; content: string }>())
      .output(type<{ path: string }>()),
    saveImage: oc
      .input(type<{ documentPath: string; file: File }>())
      .output(type<{ src: string }>()),
    events: oc.output(asyncIteratorObject(type<WorkspaceTreeEvent[]>())),
  },
  sessions: {
    list: oc.output(type<SessionSummary[]>()),
    create: oc.output(type<{ sessionId: string }>()),
    snapshot: oc
      .input(type<{ sessionId: string }>())
      .output(type<SessionSnapshot>()),
    watch: oc
      .input(type<{ sessionId: string }>())
      .output(asyncIteratorObject(type<SessionWatchItem>())),
    prompt: oc.input(type<{ sessionId: string; text: string }>()),
    startConnection: oc
      .input(
        type<{
          sessionId: string;
          request: ConnectionRequest;
          completion: OAuthCompletion;
        }>(),
      )
      .output(type<ConnectionStarted>()),
    completeOAuth: oc.input(type<{ state: string; code: string }>()),
    cancelConnection:
      oc.input(type<{ sessionId: string; connectionId: string }>()),
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
  testHarness: {
    loadSession: oc
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
