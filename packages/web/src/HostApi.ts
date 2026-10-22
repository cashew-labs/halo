import type {
  ConnectionRequest,
  ConnectionStarted,
  HaloClient,
  Hotkey,
} from "@get-halo/client";
import type {
  ControlPlaneWorkspaceStatus,
  ControlPlaneSession,
  IntegrationSetup,
} from "@get-halo/shared/controlPlaneContract";
import type { ShortcutId } from "./shortcuts.js";

export type AppUpdateStatus =
  | { state: "disabled"; reason: string }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available" }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

export type AppInfo = {
  version: string;
  development?: boolean;
  /** Which deployment a packaged desktop follows; absent means production. */
  releaseChannel?: "production" | "staging"; // coverage-exempt: a type declaration emits no runtime code
  /** Host name of the deployment this app signs in to; absent for a local identity. */
  deployment?: string; // coverage-exempt: a type declaration emits no runtime code
  update: AppUpdateStatus;
};

/** The computer the desktop app runs on, as the workspace agent sees it. */
export type LocalDeviceState = {
  name: string;
  enabled: boolean;
  /** Folders the person allowed when the agent first asked. */
  files: { grants: { path: string; access: "read" | "write" }[] };
  /** Whether the person allowed the agent to run commands here. */
  commands: { allowed: boolean };
  status:
    | { state: "disabled" }
    | { state: "connecting" }
    | { state: "online"; since: number }
    | { state: "offline"; message: string; retryAt: number };
};

export type LocalDeviceUpdate = Partial<
  Pick<LocalDeviceState, "name" | "enabled" | "files" | "commands">
>;

export type LocalDeviceAccessAnswer =
  | "read"
  | "write"
  | "deny"
  | "allowCommands";

/** Permission requests are answered only in the desktop that owns the device. */
export type LocalDeviceAccessRequest = {
  id: string;
  sessionId: string;
  toolCallId: string;
  status:
    | "pending"
    | "read"
    | "write"
    | "allowed"
    | "denied"
    | "cancelled"
    | "removed";
  prompt:
    | { kind: "files"; folder: string; path: string; access: "read" | "write" }
    | { kind: "commands"; command: string; cwd: string };
};

export interface HostApi {
  /** Present only where Halo can let the agent use this computer. */
  // coverage-exempt: type declarations
  device?: {
    read(): Promise<LocalDeviceState | Error>;
    update(update: LocalDeviceUpdate): Promise<LocalDeviceState | Error>;
    readAccessRequests(): Promise<LocalDeviceAccessRequest[] | Error>;
    onAccessRequests(
      listener: (requests: LocalDeviceAccessRequest[]) => void,
    ): () => void;
    respondToAccessRequest(input: {
      requestId: string;
      answer: LocalDeviceAccessAnswer;
    }): Promise<void | Error>;
  };
  integrationSetup?: {
    read(setupId: string): Promise<IntegrationSetup | Error>;
    submit(input: {
      setupId: string;
      template: string;
      values: Record<string, string>;
    }): Promise<{ authorizationUrl?: string } | Error>;
    cancel(setupId: string): Promise<void | Error>;
    // Binds this browser to the setup with Halo's single-use handoff.
    // coverage-exempt: type declarations
    redeemHandoff(input: {
      setupId: string;
      handoff: string;
    }): Promise<void | Error>;
    // Signs in to the Halo account that requested the setup.
    signIn(): Promise<ControlPlaneSession | Error | undefined>;
  };
  /** Selects environment branding such as the logo; absent means production. */
  readonly environment?: "production" | "staging" | "development"; // coverage-exempt: a type declaration emits no runtime code
  getWorkspaceStatus?(): Promise<
    ControlPlaneWorkspaceStatus | Error | undefined
  >;
  recordWorkspaceActivity?(): Promise<void | Error>;
  showLandingPage?: boolean;
  setHotkeys?(hotkeys: Hotkey[]): void;
  onShortcut?(listener: (shortcut: ShortcutId) => void): () => void;
  closeWindow?(): void;
  getAuthSession(): Promise<ControlPlaneSession | Error | undefined>;
  signIn(): Promise<ControlPlaneSession | Error | undefined>;
  /** Ends the saved session; the app then shows its signed-out screen. */
  signOut(): Promise<void | Error>; // coverage-exempt: a type declaration emits no runtime code
  connectHalo(options: {
    onDisconnect: (error: Error) => void;
    signal: AbortSignal;
    canRequest: (path: string[]) => boolean;
  }): Promise<HaloClient | Error | undefined>;
  getExtensionFrameUrl(extensionId: string): string;
  getDesktopFrameUrl(): string;
  getAppInfo?(): Promise<AppInfo | Error>;
  checkForAppUpdate?(): Promise<void | Error>;
  installAppUpdate?(): Promise<void | Error>;
  openExternalUrl?(url: string): Promise<void | Error>;
  connectIntegration(input: {
    sessionId: string;
    request: ConnectionRequest;
  }): Promise<ConnectionStarted | Error>;
  cancelIntegration(input: {
    sessionId: string;
    connectionId: string;
  }): Promise<void | Error>;
}
