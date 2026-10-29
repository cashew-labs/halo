import type { ShortcutId } from "./shortcuts.js";
import { type Static, Type } from "@sinclair/typebox";
import {
  connectionRequestSchema,
  type Hotkey,
  type ConnectionFailureData,
  type ConnectionRequest,
} from "@get-halo/client";
import type {
  ControlPlaneWorkspaceStatus,
  ControlPlaneSession,
} from "@get-halo/shared/controlPlaneContract";
import type {
  AppInfo,
  IntegrationConnectionStarted,
} from "@get-halo/web/HostApi";
import type { HaloRpcConnection } from "./HaloRpcConnection.js";

export const DESKTOP_CHANNEL = "halo:desktop";

export const desktopRequestSchema = Type.Union([
  Type.Object(
    { type: Type.Literal("getWorkspaceStatus") },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("recordWorkspaceActivity") },
    { additionalProperties: false },
  ),
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
    { type: Type.Literal("signOut") },
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
      threadId: Type.String(),
      request: connectionRequestSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("cancelIntegration"),
      threadId: Type.String(),
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
  environment: "production" | "staging" | "development";
  getWorkspaceStatus: () => Promise<ControlPlaneWorkspaceStatus | undefined>;
  recordWorkspaceActivity: () => Promise<void>;
  setHotkeys: (hotkeys: Hotkey[]) => void;
  onShortcut: (listener: (shortcut: ShortcutId) => void) => () => void;
  getConnection: () => Promise<
    HaloRpcConnection | ConnectionFailureData | undefined
  >;
  getAuthSession: () => Promise<
    ControlPlaneSession | ConnectionFailureData | undefined
  >;
  signIn: () => Promise<ControlPlaneSession | ConnectionFailureData>;
  signOut: () => Promise<void>;
  getAppInfo: () => Promise<AppInfo>;
  checkForAppUpdate: () => Promise<void>;
  installAppUpdate: () => Promise<void>;
  openExternal: (request: { url: string }) => Promise<void>;
  connectIntegration: (input: {
    threadId: string;
    request: ConnectionRequest;
  }) => Promise<IntegrationConnectionStarted>;
  cancelIntegration: (input: {
    threadId: string;
    connectionId: string;
  }) => Promise<void>;
};

declare global {
  interface Window {
    haloDesktop: DesktopBridge;
  }
}
