export {
  WorkspaceServer,
  type WorkspaceServerOptions,
  type WorkspaceServerConfig,
  type WorkspaceServerHost,
} from "./server/WorkspaceServer.js";
export {
  workspaceServerReadySchema,
  type WorkspaceServerReady,
} from "./server/WorkspaceServerReady.js";
export type { ExtensionRuntime } from "./extensions/startExtension.js";
export type { RemoteIntegrationTools } from "./agent/runtime/ToolRuntime.js";
export { ControlPlaneTraceUploader } from "./traces/ControlPlaneTraceUploader.js";
export { ControlPlaneWorkReporter } from "./server/ControlPlaneWorkReporter.js";
export { ControlPlaneScheduleReporter } from "./automations/ControlPlaneScheduleReporter.js"; // coverage-exempt: Rename-only public export.
export type { TraceUploader } from "./traces/TraceService.js";

export { ControlPlaneAutomationClient } from "./automations/ControlPlaneAutomationClient.js";
