import type {
  ConnectionRequest,
  ConnectionStarted,
  HaloClient,
  Hotkey,
} from "@get-halo/client";
import type { ControlPlaneSession } from "@get-halo/shared/controlPlaneContract";
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
  update: AppUpdateStatus;
};

export interface HostApi {
  setHotkeys?(hotkeys: Hotkey[]): void;
  onShortcut?(listener: (shortcut: ShortcutId) => void): () => void;
  getAuthSession(): Promise<ControlPlaneSession | Error | undefined>;
  signIn(): Promise<ControlPlaneSession | Error | undefined>;
  connectHalo(options: {
    onDisconnect: (error: Error) => void;
  }): Promise<HaloClient | Error | undefined>;
  getExtensionFrameUrl(extensionId: string): string;
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
