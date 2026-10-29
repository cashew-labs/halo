export { createWorkspaceRemote } from "./database/createWorkspaceRemote.js";
export { automationRunSelect } from "./database/schema/automations.js";
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
  type ExtensionSummary,
  type ExtensionArtifact, // coverage-exempt: Type-only public export; behavior is covered through the workspace RPC.
  type AppSummary, // coverage-exempt: Type-only public export.
  type AppAccessList, // coverage-exempt: Type-only public export.
  type AppActionBinding, // coverage-exempt: Type-only public export.
  type TemplateSummary, // coverage-exempt: Type-only public export.
  type WorkspaceUpdate,
} from "./contract.js";
export type { WorkspaceSearchHit, WorkspaceSearchResponse } from "./search.js";
export {
  connectionRequestSchema,
  connectionRequestKey,
  connectionRequestName,
  connectionRequestLabel,
  type ConnectionRequest,
  type IntegrationConnection,
} from "./ConnectionRequest.js";
export {
  integrationDisplay,
  type IntegrationDisplay,
} from "./IntegrationDisplay.js";
export {
  haloMessageSchema,
  execToolCallSchema,
  toolApprovalSchema,
  toolApprovalDecisionCustomType,
  userInterruptionCustomType,
  directToolIdentity,
  emptyThreadSnapshot,
  reduceThreadUpdate,
  applyThreadEvent,
  applyConnectionEvent,
  executionWithOutput,
  threadMessages,
  threadToolExecutions,
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
  type ThreadSnapshot,
  type ThreadEvent,
  type ThreadWatchItem,
} from "./threadState.js";
// coverage-exempt: Public barrel re-exports; behavior is exercised through the defining modules.
export {
  traceUploadLimits,
  type TraceAgent,
  type TraceEvent,
  type TraceOutcome,
  type TraceRecord,
} from "./traces.js";
export type {
  WorkspaceInfo,
  ThreadSummary,
  ThreadSummariesUpdate,
  WorkspaceTreeEvent,
  WorkspaceFilePreview,
} from "./rpc.js";
export { isThreadUnread } from "./rpc.js";

export {
  newAgentSchema,
  agentSettingsSchema,
  type AgentRecord,
  type NewAgentInput,
  type AgentSettingsInput,
} from "./agents.js";

export { imageFilename, imageMediaTypes } from "./imageFilename.js";
// coverage-exempt: Public barrel re-exports; behavior is exercised through the defining modules.
export {
  chatAttachmentLimits,
  chatAttachmentSchema,
  chatImageExtensions,
  chatReferenceSchema,
  chatPromptContent,
  chatPromptTitle,
  validateChatFiles,
  type ChatAttachment,
  type ChatReference,
  type ChatPrompt,
} from "./chatAttachments.js";
// coverage-exempt: Public barrel re-exports; behavior is exercised through the defining modules.
export {
  uploadChatFile,
  ChatUploadError,
  ChatUploadRejectedError,
  ChatUploadCancelledError,
} from "./uploadChatFile.js";
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
  memoryScopes,
  memoryEntryMaxChars,
  memoryScopeSchema,
  memoryChangeSchema,
  memoryUpdateSchema,
  type MemoryScope,
  type MemoryChange,
  type MemoryUpdate,
  type MemoryEntry,
  type MemoryUsage,
} from "./memory.js";

export {
  automationRegistrationSchema,
  automationSnapshotSchema,
  type AutomationGmailConnection,
  type AutomationRegistration,
  type AutomationSnapshot,
  type AutomationDelivery,
  type AutomationSourceState,
  type AutomationWebhookAccess,
  automationEventSchema,
  type AutomationEvent,
  automationActionSchema,
  automationActivationSchema,
  automationInputSchema,
  InvalidAutomationError,
  type Automation,
  type AutomationAction,
  type AutomationActivation,
  type AutomationInput,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationRunTrigger,
} from "./automations.js";
