import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import {
  createHaloClient,
  serializeConnectionFailure,
  type HaloClient,
} from "@get-halo/client";
import {
  DESKTOP_CHANNEL,
  desktopRequestSchema,
  type CancelIntegrationRequest,
  type ConnectIntegrationRequest,
  type DesktopRequest,
} from "../../shared/desktop.js";
import type { AppUpdates } from "../app/AppUpdates.js";
import type { StagingToggle } from "../app/StagingToggle.js";
import type { DesktopAuthentication } from "../DesktopAuthentication.js";
import type { HaloRpcConnection } from "../../shared/HaloRpcConnection.js";
import { openExternalUrl } from "../openExternalUrl.js";
import type { LocalDevice } from "../device/LocalDevice.js";

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
  appUpdates: AppUpdates;
  stagingToggle: StagingToggle;
  getConnection: () => Promise<HaloRpcConnection | Error | undefined>;
  ownsWindow: (window: BrowserWindow) => boolean;
  device: LocalDevice | undefined;
}): void {
  ipcMain.handle(DESKTOP_CHANNEL, async (event, request: DesktopRequest) => {
    assertTrustedSender({ event, ownsWindow: args.ownsWindow });
    const validated = validateDesktopRequest(request);
    if (validated instanceof Error) throw validated;
    const result = await handleDesktopRequest({
      request: validated,
      authentication: args.authentication,
      appUpdates: args.appUpdates,
      stagingToggle: args.stagingToggle,
      getConnection: args.getConnection,
      device: args.device,
      window: BrowserWindow.fromWebContents(event.sender) ?? undefined,
    });
    if (
      result instanceof Error &&
      ["getConnection", "getAuthSession", "signIn"].includes(request.type)
    )
      return serializeConnectionFailure(result);
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
  appUpdates: AppUpdates;
  stagingToggle: StagingToggle;
  getConnection: () => Promise<HaloRpcConnection | Error | undefined>;
  device: LocalDevice | undefined;
  window: BrowserWindow | undefined;
}) {
  switch (args.request.type) {
    case "getWorkspaceStatus":
      return await args.authentication.getWorkspaceStatus?.();
    case "recordWorkspaceActivity":
      return await args.authentication.recordWorkspaceActivity?.();
    case "getConnection": {
      return await args.getConnection();
    }
    case "getAuthSession": {
      const session = await args.authentication.getSession();
      args.stagingToggle.observe(session);
      return session;
    }
    case "signIn": {
      const session = await args.authentication.signIn();
      args.stagingToggle.observe(session);
      args.device?.reconnect();
      return session;
    }
    case "signOut": {
      const signedOut = await args.authentication.signOut();
      if (!(signedOut instanceof Error)) args.stagingToggle.observe(undefined);
      args.device?.reconnect();
      return signedOut;
    }
    case "getDevice":
      return args.device?.state() ?? deviceUnavailable();
    case "updateDevice":
      return (
        (await args.device?.update(args.request.update)) ?? deviceUnavailable()
      );
    case "addDeviceFolder":
      return (await args.device?.addFolder(args.window)) ?? deviceUnavailable();
    case "getAppInfo":
      return args.appUpdates.getAppInfo();
    case "checkForAppUpdate":
      return await args.appUpdates.checkForAppUpdate();
    case "installAppUpdate":
      return await args.appUpdates.installAppUpdate();
    case "openExternal":
      return await openExternalUrl(args.request.url);
    case "connectIntegration":
      return await connectIntegration({
        request: args.request,
        getConnection: args.getConnection,
        createSetupHandoff: async (setupUrl) =>
          await args.authentication.createSetupHandoff?.(setupUrl),
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

function deviceUnavailable() {
  return new DesktopOperationError({
    operation: "load this computer's settings",
  });
}

async function connectIntegration(args: {
  request: ConnectIntegrationRequest;
  getConnection: () => Promise<HaloRpcConnection | Error | undefined>;
  createSetupHandoff: (setupUrl: string) => Promise<string | Error | undefined>;
}) {
  const connection = await args.getConnection();
  if (connection instanceof Error) return connection;
  if (connection === undefined) {
    return new DesktopOperationError({
      operation: "start a connection without a workspace",
    });
  }

  const client = createWorkspaceClient(connection);
  const started = await client.thread
    .startConnection({
      sessionId: args.request.sessionId,
      request: args.request.request,
    })
    .catch(
      (cause) =>
        new DesktopOperationError({
          operation: "start the connection",
          cause,
        }),
    );
  if (started instanceof Error) return started;
  if (started.status === "connected") return started;

  // Without a handoff, the browser must be signed in to the same Halo account.
  const handoff = await args.createSetupHandoff(started.authorizationUrl);
  if (handoff instanceof Error)
    console.warn("Opening setup without a handoff:", handoff);
  const setupUrl =
    handoff === undefined || handoff instanceof Error
      ? started.authorizationUrl
      : handoff;
  const opened = await openExternalUrl(setupUrl);
  if (opened instanceof Error) {
    await cancelPendingConnection({
      client,
      sessionId: args.request.sessionId,
      connectionId: started.connectionId,
    });
    return new DesktopOperationError({
      operation: "open the authorization page",
      cause: opened,
    });
  }

  return started;
}

async function cancelIntegration(args: {
  request: CancelIntegrationRequest;
  getConnection: () => Promise<HaloRpcConnection | Error | undefined>;
}) {
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

async function cancelPendingConnection(args: {
  client: HaloClient;
  sessionId: string;
  connectionId: string;
}) {
  const cancelled = await args.client.thread
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
    console.warn("Connection cancellation failed:", cancelled);
  }
}

function createWorkspaceClient(connection: HaloRpcConnection) {
  return createHaloClient({
    transport: {
      origin: connection.origin,
      path: connection.path,
      headers: { authorization: `Bearer ${connection.token}` },
    },
  });
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
