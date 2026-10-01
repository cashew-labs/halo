export { createWorkspaceRemote } from "./database/createWorkspaceRemote.js";
export {
  haloSchema,
  haloSchemaToTandemSchema,
  haloSchemaToTursoTables,
  type Field,
  type Fields,
  type Schema,
  type SchemaRecords,
  type SqlValue,
  type Table,
  type TableRecord,
} from "./database/schema/schema.js";
export {
  workspaceSchema,
  type WorkspaceSchema,
} from "./database/schema/workspaceSchema.js";
export {
  AuthenticationRequiredError,
  ConnectionUnavailableError,
  ConnectionHttpError,
  serializeConnectionFailure,
  restoreConnectionFailure,
  type ConnectionFailureData,
} from "./connectionErrors.js";
export {
  checkServerCompatibility,
  acceptsProtocol,
  protocolHeader,
  InvalidServerInfoError,
  type ProtocolService,
  type ServerInfo,
} from "./protocol.js";
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
  haloSupportedProtocols,
  RequestRejectedError,
  type HaloClient,
  type ConnectionStarted,
  type OAuthCompletion,
  type ExtensionSummary,
  type WorkspaceUpdate,
  type BrowserSnapshot,
  type BrowserExecution,
} from "./contract.js";
export type { WorkspaceSearchHit, WorkspaceSearchResponse } from "./search.js";
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
  toolApprovalSchema,
  toolApprovalDecisionCustomType,
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
  type ToolApproval,
  type ToolApprovalDecision,
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
  chatReferenceSchema,
  chatPromptContent,
  chatPromptTitle,
  validateChatFiles,
  type ChatAttachment,
  type ChatReference,
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
export {
  routineActionSchema,
  routineInputSchema,
  InvalidRoutineError,
  type Routine,
  type RoutineAction,
  type RoutineInput,
  type RoutineRun,
  type RoutineRunStatus,
  type RoutineRunTrigger,
} from "./routines.js";
