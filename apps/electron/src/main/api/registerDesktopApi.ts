import fs from "node:fs/promises";
import path from "node:path";
import {
  BrowserWindow,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import type { WorkspaceServerConnection } from "@get-halo/workspace-server/connection";
import {
  DESKTOP_CHANNEL,
  desktopRequestSchema,
  type DesktopRequest,
  type OpenExternalRequest,
} from "../../shared/desktop.js";
import { getAppInfo, installAppUpdate } from "../app/appUpdate.js";
import type { DesktopAuthentication } from "../DesktopAuthentication.js";
import type { HaloRpcConnection } from "../../shared/HaloRpcConnection.js";

class DesktopRequestError extends errore.createTaggedError({
  name: "DesktopRequestError",
  message: "Halo rejected an invalid $operation request",
}) {}

class DesktopOperationError extends errore.createTaggedError({
  name: "DesktopOperationError",
  message: "Halo could not $operation",
}) {}

export function registerDesktopApi(args: {
  authentication: DesktopAuthentication;
  getConnection: () => Promise<HaloRpcConnection | Error | undefined>;
  getServer: () => Promise<WorkspaceServerConnection | Error | undefined>;
  ownsWindow: (window: BrowserWindow) => boolean;
}): void {
  ipcMain.handle(DESKTOP_CHANNEL, async (event, request: DesktopRequest) => {
    assertTrustedSender({ event, ownsWindow: args.ownsWindow });
    const validated = validateDesktopRequest(request);
    if (validated instanceof Error) throw validated;
    const result = await handleDesktopRequest({
      request: validated,
      authentication: args.authentication,
      getConnection: args.getConnection,
      getServer: args.getServer,
    });
    if (result instanceof Error) throw result;
    return result;
  });
}

function validateDesktopRequest(
  request: DesktopRequest,
): DesktopRequest | DesktopRequestError {
  if (Value.Check(desktopRequestSchema, request)) return request;
  return new DesktopRequestError({ operation: "desktop API" });
}

async function handleDesktopRequest(args: {
  request: DesktopRequest;
  authentication: DesktopAuthentication;
  getConnection: () => Promise<HaloRpcConnection | Error | undefined>;
  getServer: () => Promise<WorkspaceServerConnection | Error | undefined>;
}) {
  switch (args.request.type) {
    case "openWorkspaceFile": {
      const server = await args.getServer();
      if (server instanceof Error) return server;
      return await openWorkspaceFile(server?.workspaceRoot, args.request.path);
    }
    case "getConnection": {
      return await args.getConnection();
    }
    case "getAuthSession":
      return await args.authentication.getSession();
    case "signIn":
      return await args.authentication.signIn();
    case "getAppInfo":
      return getAppInfo();
    case "installAppUpdate":
      return installAppUpdate();
    case "openExternal":
      return await openExternal(args.request);
    default:
      return new DesktopRequestError({ operation: "desktop API" });
  }
}

async function openExternal(request: OpenExternalRequest) {
  const url = errore.try({
    try: () => new URL(request.url),
    catch: (e) =>
      new DesktopOperationError({
        operation: "open an invalid external URL",
        cause: e,
      }),
  });
  if (url instanceof Error) return url;
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return new DesktopOperationError({
      operation: `open an external ${url.protocol} URL`,
    });
  }
  return await shell
    .openExternal(url.toString())
    .catch(
      (e) => new DesktopOperationError({ operation: "open the URL", cause: e }),
    );
}

function assertTrustedSender(args: {
  event: IpcMainInvokeEvent;
  ownsWindow: (window: BrowserWindow) => boolean;
}): BrowserWindow {
  const senderWindow = BrowserWindow.fromWebContents(args.event.sender);
  if (senderWindow === null || !args.ownsWindow(senderWindow)) {
    throw new Error("Halo rejected IPC from an unknown renderer.");
  }
  return senderWindow;
}

async function openWorkspaceFile(
  root: string | undefined,
  relativePath: string,
) {
  if (root === undefined)
    return new DesktopOperationError({
      operation: "open a file without a workspace",
    });
  const absolutePath = path.resolve(root, relativePath);
  if (
    path.relative(root, absolutePath).split(path.sep).join("/") !==
      relativePath ||
    relativePath
      .split("/")
      .some((part) => part.startsWith(".") || part === "node_modules")
  ) {
    return new DesktopRequestError({ operation: "workspace file" });
  }
  const resolved = await fs
    .realpath(absolutePath)
    .catch(
      (cause) =>
        new DesktopOperationError({ operation: "locate the file", cause }),
    );
  if (resolved instanceof Error) return resolved;
  if (!resolved.startsWith(`${root}${path.sep}`))
    return new DesktopRequestError({ operation: "workspace file" });
  const error = await shell
    .openPath(resolved)
    .catch(
      (cause) =>
        new DesktopOperationError({ operation: "open the file", cause }),
    );
  if (error instanceof Error) return error;
  if (error !== "")
    return new DesktopOperationError({
      operation: "open the file",
      cause: new Error(error),
    });
}
