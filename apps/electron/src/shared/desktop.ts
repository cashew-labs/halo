import type { ShortcutId } from "./shortcuts.js";
import { type Static, Type } from "@sinclair/typebox";
import {
  connectionRequestSchema,
  type Hotkey,
  type ConnectionFailureData,
  type ConnectionRequest,
  type ConnectionStarted,
} from "@get-halo/client";
import type {
  ControlPlaneWorkspaceStatus,
  ControlPlaneSession,
} from "@get-halo/shared/controlPlaneContract";
import type { AppInfo, LocalDeviceInfo } from "@get-halo/web/HostApi";
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
      sessionId: Type.String(),
      request: connectionRequestSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("getDevice") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("allowDevicePermission"),
      request: Type.Union([
        Type.Object(
          {
            kind: Type.Literal("folder"),
            folder: Type.String({ minLength: 1 }),
            access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
            path: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            kind: Type.Literal("commands"),
            command: Type.String(),
            cwd: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
      ]),
      access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
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
type AllowDevicePermissionRequest = Extract<
  DesktopRequest,
  { type: "allowDevicePermission" }
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
    sessionId: string;
    request: ConnectionRequest;
  }) => Promise<ConnectionStarted>;
  cancelIntegration: (input: {
    sessionId: string;
    connectionId: string;
  }) => Promise<void>;
  getDevice: () => Promise<LocalDeviceInfo>;
  allowDevicePermission: (
    input: Omit<AllowDevicePermissionRequest, "type">,
  ) => Promise<void>;
};

declare global {
  interface Window {
    haloDesktop: DesktopBridge;
  }
}
