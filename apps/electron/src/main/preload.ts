import type { LogLevel, LoggerData, LoggerScope } from "@repo/logger";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { contextBridge, ipcRenderer } from "electron";
import { LOG_CHANNELS } from "../shared/channels.js";
import { DESKTOP_CHANNEL, type DesktopApi } from "../shared/desktop.js";

const desktopApi: DesktopApi = {
  openWorkspaceFile: async (path) =>
    await ipcRenderer.invoke(DESKTOP_CHANNEL, {
      type: "openWorkspaceFile",
      path,
    }),
  getConnection: async () =>
    await ipcRenderer.invoke(DESKTOP_CHANNEL, { type: "getConnection" }),
  getAuthSession: async () =>
    await ipcRenderer.invoke(DESKTOP_CHANNEL, { type: "getAuthSession" }),
  signIn: async () =>
    await ipcRenderer.invoke(DESKTOP_CHANNEL, { type: "signIn" }),
  getAppInfo: async () =>
    await ipcRenderer.invoke(DESKTOP_CHANNEL, { type: "getAppInfo" }),
  installAppUpdate: async () =>
    await ipcRenderer.invoke(DESKTOP_CHANNEL, { type: "installAppUpdate" }),
  openExternal: async (request) =>
    await ipcRenderer.invoke(DESKTOP_CHANNEL, {
      type: "openExternal",
      url: request.url,
    }),
  connectIntegration: async (input) =>
    await ipcRenderer.invoke(DESKTOP_CHANNEL, {
      type: "connectIntegration",
      sessionId: input.sessionId,
      request: input.request,
    }),
  cancelIntegration: async (input) =>
    await ipcRenderer.invoke(DESKTOP_CHANNEL, {
      type: "cancelIntegration",
      sessionId: input.sessionId,
      connectionId: input.connectionId,
    }),
};

contextBridge.exposeInMainWorld("haloDesktop", desktopApi);

const logMessageSchema = Type.Object({
  channel: Type.Literal(LOG_CHANNELS.log),
  payload: Type.Object({
    level: Type.Union([
      Type.Literal("debug"),
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("log"),
      Type.Literal("error"),
    ]),
    scopes: Type.Array(Type.Unknown()),
    data: Type.Unknown(),
  }),
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const log = parseLogMessage({ data: event.data });
  if (log !== undefined) {
    ipcRenderer.send(LOG_CHANNELS.log, log.payload);
  }
});

type LogMessage = {
  channel: typeof LOG_CHANNELS.log;
  payload: {
    level: LogLevel;
    scopes: readonly LoggerScope[];
    data: LoggerData;
  };
};

function parseLogMessage(args: { data: unknown }): LogMessage | undefined {
  if (!Value.Check(logMessageSchema, args.data)) return undefined;
  // SAFETY: logMessageSchema is the halo:log window-message contract.
  return args.data as LogMessage;
}
