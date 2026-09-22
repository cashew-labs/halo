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
  type WorkspaceUpdate,
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
  SessionSummariesUpdate,
  WorkspaceTreeEvent,
  WorkspaceFilePreview,
} from "./rpc.js";
export { isThreadUnread } from "./rpc.js";

export { imageFilename, imageMediaTypes } from "./imageFilename.js";
export {
  chatAttachmentLimits,
  chatAttachmentSchema,
  chatPromptTitle,
  validateChatFiles,
  type ChatAttachment,
  type ChatPrompt,
} from "./chatAttachments.js";
export {
  hotkeyActionSchema,
  hotkeyInputSchema,
  hotkeySchema,
  normalizeHotkey,
  matchesHotkey,
  InvalidHotkeyError,
  type Hotkey,
  type HotkeyInput,
  type HotkeyAction,
} from "./hotkeys.js";
