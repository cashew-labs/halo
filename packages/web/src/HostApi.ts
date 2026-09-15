import type { HaloClient } from "@get-halo/shared/contract";
import type { ControlPlaneSession } from "@get-halo/shared/controlPlaneContract";

export interface HostApi {
  getAuthSession(): Promise<ControlPlaneSession | Error | undefined>;
  signIn(): Promise<ControlPlaneSession | Error>;
  connectHalo(options: {
    onDisconnect: (error: Error) => void;
  }): Promise<HaloClient | Error | undefined>;
  getExtensionFrameUrl(extensionId: string): string;
}
