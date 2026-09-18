import type { ShortcutId } from "./shortcuts.js";
import { type Static, Type } from "@sinclair/typebox";
import {
  connectionRequestSchema,
  type ConnectionRequest,
  type ConnectionStarted,
} from "@get-halo/client";
import type { ControlPlaneSession } from "@get-halo/shared/controlPlaneContract";
import type { AppInfo } from "@get-halo/web/HostApi";
import type { HaloRpcConnection } from "./HaloRpcConnection.js";

export const DESKTOP_CHANNEL = "halo:desktop";

export const desktopRequestSchema = Type.Union([
  Type.Object(
    { type: Type.Literal("getConnection") },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("getAuthSession") },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("signIn") },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("getAppInfo") },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("checkForAppUpdate") },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("installAppUpdate") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("openExternal"),
      url: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("connectIntegration"),
      sessionId: Type.String(),
      request: connectionRequestSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("cancelIntegration"),
      sessionId: Type.String(),
      connectionId: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

export type DesktopRequest = Static<typeof desktopRequestSchema>;
export type ConnectIntegrationRequest = Extract<
  DesktopRequest,
  { type: "connectIntegration" }
>;
export type CancelIntegrationRequest = Extract<
  DesktopRequest,
  { type: "cancelIntegration" }
>;

export type DesktopBridge = {
  onShortcut: (listener: (shortcut: ShortcutId) => void) => () => void;
  getConnection: () => Promise<HaloRpcConnection | undefined>;
  getAuthSession: () => Promise<ControlPlaneSession | undefined>;
  signIn: () => Promise<ControlPlaneSession>;
  getAppInfo: () => Promise<AppInfo>;
  checkForAppUpdate: () => Promise<void>;
  installAppUpdate: () => Promise<void>;
  openExternal: (request: { url: string }) => Promise<void>;
  connectIntegration: (input: {
    sessionId: string;
    request: ConnectionRequest;
  }) => Promise<ConnectionStarted>;
  cancelIntegration: (input: {
    sessionId: string;
    connectionId: string;
  }) => Promise<void>;
};

declare global {
  interface Window {
    haloDesktop: DesktopBridge;
  }
}
