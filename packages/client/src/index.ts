export {
  createHaloClient,
  connectHaloClient,
  HaloRpcConnectionError,
  IncompatibleServerError,
  type HaloRpcTransport,
} from "./createHaloClient.js";
export {
  contract,
  haloProtocolVersion,
  RequestRejectedError,
  type HaloClient,
  type ConnectionStarted,
  type OAuthCompletion,
  type ExtensionSummary,
  type BrowserSnapshot,
  type BrowserExecution,
} from "./contract.js";
export {
  connectionRequestSchema,
  connectionRequestKey,
  connectionRequestLabel,
  type ConnectionRequest,
} from "./ConnectionRequest.js";
export {
  googleIntegrationDisplay,
  type GoogleIntegrationDisplay,
} from "./GoogleIntegrationDisplay.js";
export {
  haloMessageSchema,
  execToolCallSchema,
  directToolIdentity,
  emptySessionSnapshot,
  reduceSessionUpdate,
  applySessionEvent,
  applyConnectionEvent,
  executionWithOutput,
  sessionMessages,
  sessionToolExecutions,
  type HaloMessage,
  type ToolIdentity,
  type ExecToolCall,
  type HaloConnectionEvent,
  type HaloConnectionState,
  type ToolResult,
  type ToolOutput,
  type ToolExecution,
  type HaloEntry,
  type ActiveRun,
  type RunResult,
  type SessionSnapshot,
  type SessionEvent,
  type SessionWatchItem,
} from "./sessionState.js";
export type {
  TraceAgent,
  TraceEvent,
  TraceOutcome,
  TraceRecord,
} from "./traces.js";
export type {
  WorkspaceInfo,
  SessionSummary,
  WorkspaceTreeEvent,
  WorkspaceFilePreview,
} from "./rpc.js";
