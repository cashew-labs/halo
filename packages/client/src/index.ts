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
  type BrowserSnapshot,
  type BrowserExecution,
} from "./contract.js";
export {
  deviceFileLimits,
  type DeviceAdvertisement,
  type DeviceFileAccess,
  type DeviceFileEncoding,
  type DeviceFileEntry,
  type DeviceOperation,
  type DeviceOperationResult,
  type DeviceOperationOutput,
  type DeviceRequest,
  type DeviceResponse,
  type DeviceSummary,
} from "./devices.js";
export type { WorkspaceSearchHit, WorkspaceSearchResponse } from "./search.js";
export {
  connectionRequestSchema,
  connectionRequestKey,
  connectionRequestLabel,
  type ConnectionRequest,
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
  SessionSummary,
  SessionSummariesUpdate,
  WorkspaceTreeEvent,
  WorkspaceFilePreview,
} from "./rpc.js";
export { isThreadUnread } from "./rpc.js";

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
