import type { ConnectionRequest } from "@get-halo/shared/ConnectionRequest";
import type { ConnectionStarted, HaloClient } from "@get-halo/shared/contract";
import type { ControlPlaneSession } from "@get-halo/shared/controlPlaneContract";

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
  getAuthSession(): Promise<ControlPlaneSession | Error | undefined>;
  signIn(): Promise<ControlPlaneSession | Error>;
  connectHalo(options: {
    onDisconnect: (error: Error) => void;
  }): Promise<HaloClient | Error | undefined>;
  getExtensionFrameUrl(extensionId: string): string;
  getAppInfo?(): Promise<AppInfo | Error>;
  installAppUpdate?(): Promise<void | Error>;
  connectIntegration(input: {
    sessionId: string;
    request: ConnectionRequest;
  }): Promise<ConnectionStarted | Error>;
  cancelIntegration(input: {
    sessionId: string;
    connectionId: string;
  }): Promise<void | Error>;
}
