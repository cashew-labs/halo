import fs from "node:fs/promises";
import path from "node:path";
import {
  BrowserWindow,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import type { WorkspaceServerConnection } from "@get-halo/workspace-server/connection";
import type { HaloClient } from "@get-halo/shared/contract";
import {
  DESKTOP_CHANNEL,
  desktopRequestSchema,
  type CancelIntegrationRequest,
  type ConnectIntegrationRequest,
  type DesktopRequest,
  type OpenExternalRequest,
} from "../../shared/desktop.js";
import { getAppInfo, installAppUpdate } from "../app/appUpdate.js";
import type { DesktopAuthentication } from "../DesktopAuthentication.js";
import type { HaloRpcConnection } from "../../shared/HaloRpcConnection.js";
import {
  listenForLoopbackCallback,
  type ListeningLoopbackCallback,
} from "./listenForLoopbackCallback.js";
import { openExternalUrl } from "../openExternalUrl.js";

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
    case "connectIntegration":
      return await connectIntegration({
        request: args.request,
        getConnection: args.getConnection,
      });
    case "cancelIntegration":
      return await cancelIntegration({
        request: args.request,
        getConnection: args.getConnection,
      });
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
  const opened = await openExternalUrl(url.toString());
  if (opened instanceof Error) {
    return new DesktopOperationError({
      operation: "open the URL",
      cause: opened,
    });
  }
}

// Executor pending OAuth sessions last OAUTH2_SESSION_TTL_MS (15 minutes).
const oauthCallbackTimeoutMs = 15 * 60 * 1_000;
const pendingOAuthCallbacks = new Map<string, ListeningLoopbackCallback>();

export async function closePendingOAuthCallbacks() {
  const callbacks = [...pendingOAuthCallbacks.values()];
  pendingOAuthCallbacks.clear();
  for (const callback of callbacks) {
    await closeOAuthCallback(callback);
  }
}

async function connectIntegration(args: {
  request: ConnectIntegrationRequest;
  getConnection: () => Promise<HaloRpcConnection | Error | undefined>;
}) {
  const connection = await args.getConnection();
  if (connection instanceof Error) return connection;
  if (connection === undefined) {
    return new DesktopOperationError({
      operation: "start a connection without a workspace",
    });
  }

  const callback = await listenForLoopbackCallback({
    timeoutMs: oauthCallbackTimeoutMs,
  });
  if (callback instanceof Error) return callback;

  const client = createWorkspaceClient(connection);
  const started = await client.sessions
    .startConnection({
      sessionId: args.request.sessionId,
      request: args.request.request,
      redirectUri: callback.callbackUrl,
    })
    .catch(
      (cause) =>
        new DesktopOperationError({
          operation: "start the connection",
          cause,
        }),
    );
  if (started instanceof Error) {
    await closeOAuthCallback(callback);
    return started;
  }
  if (started.status === "connected") {
    await closeOAuthCallback(callback);
    return started;
  }

  const opened = await openExternalUrl(started.authorizationUrl);
  if (opened instanceof Error) {
    await cancelPendingConnection({
      client,
      sessionId: args.request.sessionId,
      connectionId: started.connectionId,
    });
    await closeOAuthCallback(callback);
    return new DesktopOperationError({
      operation: "open the authorization page",
      cause: opened,
    });
  }

  pendingOAuthCallbacks.set(started.connectionId, callback);
  void completeIntegrationOAuth({
    callback,
    client,
    sessionId: args.request.sessionId,
    connectionId: started.connectionId,
  }).catch((cause) => {
    console.warn("OAuth completion failed:", cause);
  });
  return started;
}

async function cancelIntegration(args: {
  request: CancelIntegrationRequest;
  getConnection: () => Promise<HaloRpcConnection | Error | undefined>;
}) {
  const callback = pendingOAuthCallbacks.get(args.request.connectionId);
  if (callback !== undefined) await closeOAuthCallback(callback);

  const connection = await args.getConnection();
  if (connection instanceof Error) return connection;
  if (connection === undefined) {
    return new DesktopOperationError({
      operation: "cancel a connection without a workspace",
    });
  }
  await cancelPendingConnection({
    client: createWorkspaceClient(connection),
    sessionId: args.request.sessionId,
    connectionId: args.request.connectionId,
  });
}

async function completeIntegrationOAuth(args: {
  callback: ListeningLoopbackCallback;
  client: HaloClient;
  sessionId: string;
  connectionId: string;
}) {
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(async () => {
    pendingOAuthCallbacks.delete(args.connectionId);
    await closeOAuthCallback(args.callback);
  });

  const received = await args.callback.result;
  if (received instanceof Error) {
    console.warn("OAuth callback failed:", received);
    await cancelPendingConnection(args);
    return;
  }
  if ("cancelled" in received || "providerError" in received) {
    await cancelPendingConnection(args);
    return;
  }

  const completed = await args.client.sessions
    .completeOAuth({
      state: received.state,
      code: received.code,
    })
    .catch(
      (cause) =>
        new DesktopOperationError({
          operation: "finish the connection",
          cause,
        }),
    );
  if (completed instanceof Error) {
    console.warn("OAuth completion failed:", completed);
  }
}

async function cancelPendingConnection(args: {
  client: HaloClient;
  sessionId: string;
  connectionId: string;
}) {
  const cancelled = await args.client.sessions
    .cancelConnection({
      sessionId: args.sessionId,
      connectionId: args.connectionId,
    })
    .catch(
      (cause) =>
        new DesktopOperationError({
          operation: "cancel the connection",
          cause,
        }),
    );
  if (cancelled instanceof Error) {
    console.warn("OAuth cleanup failed:", cancelled);
  }
}

async function closeOAuthCallback(callback: ListeningLoopbackCallback) {
  const closed = await callback.close();
  if (closed instanceof Error) {
    console.warn("OAuth callback close failed:", closed);
  }
}

function createWorkspaceClient(connection: HaloRpcConnection) {
  const link = new RPCLink({
    origin: connection.origin,
    url: connection.path,
    headers: { authorization: `Bearer ${connection.token}` },
  });
  // SAFETY: HaloRpcConnection points to the Halo router.
  return createORPCClient(link) as HaloClient;
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
