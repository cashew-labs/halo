import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session as electronSession,
  shell,
  type IpcMainEvent,
  type MenuItemConstructorOptions,
} from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Logger,
  type LogLevel,
  type LoggerData,
  type LoggerScope,
} from "@get-halo/logger";
import { config as resolvedApplicationConfig } from "@get-halo/config/electron";
import { ApplicationMode } from "@get-halo/config/ApplicationMode";
import type { ControlPlaneSession } from "@get-halo/shared/controlPlaneContract";
import { JsonlLoggerSink } from "@get-halo/logger/JsonlLoggerSink";
import { PrettyConsoleLoggerSink } from "@get-halo/logger/PrettyConsoleLoggerSink";
import started from "electron-squirrel-startup";
import { LOG_CHANNELS } from "../shared/channels.js";
import { SHORTCUT_CHANNEL, shortcuts } from "../shared/shortcuts.js";
import { checkForUpdates, startAppUpdates } from "./app/appUpdate.js";
import {
  createLocalDesktopAuthentication,
  type DesktopAuthentication,
} from "./DesktopAuthentication.js";
import { ControlPlaneAuth } from "./auth/ControlPlaneAuth.js";
import { createAdcDesktopIdentity } from "./auth/createAdcDesktopIdentity.js";
import {
  closePendingOAuthCallbacks,
  registerDesktopApi,
} from "./api/registerDesktopApi.js";
import type { HaloRpcConnection } from "../shared/HaloRpcConnection.js";
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

const currentDirectory = dirname(fileURLToPath(import.meta.url));

if (started) app.quit();

if (resolvedApplicationConfig instanceof Error)
  throw new Error("Electron could not read its application configuration", {
    cause: resolvedApplicationConfig,
  });
const applicationConfig = resolvedApplicationConfig;

if (applicationConfig.protectClosedStdio) {
  // Forge closes this process's stdio when it restarts main. A log after
  // that writes EPIPE; Node throws unless the stream has an error listener.
  ignoreClosedStdioPipe(process.stdout);
  ignoreClosedStdioPipe(process.stderr);
}
const fileSink = new JsonlLoggerSink({
  filePath: applicationConfig.logFilePath,
});
const logger = new Logger({
  sinks: applicationConfig.prettyConsoleLogging
    ? [new PrettyConsoleLoggerSink(), fileSink]
    : [fileSink],
});
const rendererLogger = logger.scope("renderer");

if (applicationConfig.remoteDebugging) {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", "4445");
}
if (applicationConfig.useSwiftShader) {
  // Software WebGL for headless / Xvfb hosts where Mesa llvmpipe is blocklisted.
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  app.commandLine.appendSwitch("enable-webgl");
  app.commandLine.appendSwitch("use-gl", "angle");
  app.commandLine.appendSwitch("use-angle", "swiftshader");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
}

let mainWindow: BrowserWindow | undefined;
const windows = new Set<BrowserWindow>();
// True after Quit / quitAndInstall so Close and Cmd+W destroy windows instead of hiding them.
let isQuitting = false;

// oxlint-disable-next-line typescript/no-floating-promises -- Electron owns the app-ready lifecycle and keeps the process alive for this work.
app.whenReady().then(async () => {
  const authentication = await createDesktopAuthentication();

  registerLogBridge();
  registerDesktopApi({
    authentication,
    getConnection: async () => await getWorkspaceConnection(authentication),
    ownsWindow: (window) => windows.has(window),
  });
  installMenu();
  startAppUpdates({
    config: applicationConfig.updates,
    getWindow: () => mainWindow,
  });
  await openMainWindow();
  // Forge replaces the URL with undefined in packaged builds, excluding app control.
  if (
    MAIN_WINDOW_VITE_DEV_SERVER_URL &&
    applicationConfig.mode === ApplicationMode.Development
  ) {
    const { AppControlServer } = await import("./app/AppControlServer.js");
    const appControl = await AppControlServer.start({
      target: {
        cdpUrl: "http://127.0.0.1:4445",
        pageUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
      },
      appDataDir: applicationConfig.dataDir,
    });
    if (appControl instanceof Error) {
      logger.error({ event: "app-control-start-failed", error: appControl });
      app.quit();
      return;
    }
    app.once("will-quit", (event) => {
      event.preventDefault();
      // oxlint-disable-next-line typescript/no-floating-promises -- Electron does not await event handlers; resume quitting after cleanup.
      appControl.close().then((closed) => {
        if (closed instanceof Error) console.error(closed);
        app.quit();
      });
    });
  }
  if (applicationConfig.testWindowEvents) {
    const testEvents: NodeJS.EventEmitter = app;
    testEvents.on("halo:e2e:open-window", () => {
      // Give the test-created window a separate HTTP/1.1 connection pool while
      // retaining the default Electron session used for cross-window storage.
      // oxlint-disable-next-line typescript/no-floating-promises -- The harness waits for Electron's window event.
      void createWindow(["--halo-e2e-rpc-localhost"]);
    });
  }
  logger.info({ event: "app-ready" });

  app.on("activate", () => {
    if (mainWindow === undefined) {
      // oxlint-disable-next-line typescript/no-floating-promises -- Electron activate callbacks cannot await window loading.
      void openMainWindow();
      return;
    }
    mainWindow.show();
  });
});

async function createDesktopAuthentication(): Promise<DesktopAuthentication> {
  if (applicationConfig.mode === ApplicationMode.Test) {
    const session = testAuthSession();

    return createLocalDesktopAuthentication({
      dataDir: applicationConfig.dataDir,
      identity: {
        getSession: async () => await Promise.resolve(session),
        signIn: async () => await Promise.resolve(session),
      },
    });
  }

  if (applicationConfig.mode === ApplicationMode.Development) {
    return createLocalDesktopAuthentication({
      dataDir: applicationConfig.dataDir,
      identity: createAdcDesktopIdentity(),
    });
  }

  return await ControlPlaneAuth.start({
    origin: applicationConfig.controlPlaneOrigin,
    dataDir: applicationConfig.dataDir,
  });
}

async function getWorkspaceConnection(
  authentication: DesktopAuthentication,
): Promise<HaloRpcConnection | Error | undefined> {
  const connection = await authentication.getWorkspaceConnection();
  if (connection instanceof Error || connection === undefined)
    return connection;

  authorizeExtensionRequests(connection);
  return connection;
}

function authorizeExtensionRequests(connection: HaloRpcConnection) {
  const webSocketOrigin = new URL(connection.origin);
  webSocketOrigin.protocol =
    webSocketOrigin.protocol === "http:" ? "ws:" : "wss:";
  electronSession.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        `${connection.origin}${connection.extensionPath}/*`,
        `${webSocketOrigin.origin}${connection.extensionPath}/*`,
      ],
    },
    (details, callback) => {
      details.requestHeaders.authorization = `Bearer ${connection.token}`;
      callback({ requestHeaders: details.requestHeaders });
    },
  );
}

function testAuthSession(): ControlPlaneSession {
  return {
    session: {
      id: "e2e-session",
      userId: "e2e-user",
      expiresAt: "2100-01-01T00:00:00.000Z",
    },
    user: {
      id: "e2e-user",
      email: "e2e@example.com",
      name: "E2E User",
    },
  };
}

app.on("before-quit", () => {
  isQuitting = true;
});
// quitAndInstall() emits window close before before-quit.
autoUpdater.on("before-quit-for-update", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  app.quit();
});

app.on("will-quit", () => {
  void closePendingOAuthCallbacks().catch((cause) => {
    console.warn("OAuth callback close failed:", cause);
  });
  logger.destroy();
});

async function openMainWindow(): Promise<void> {
  const window = await createWindow();
  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
}

async function createWindow(
  additionalArguments: string[] = [],
): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    show: applicationConfig.showMainWindow,
    title: "Halo",
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    center: true,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 11, y: 11 },
    webPreferences: {
      preload: join(currentDirectory, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments,
    },
  });
  windows.add(window);
  window.once("closed", () => windows.delete(window));
  if (process.platform === "darwin") {
    window.on("close", (event) => {
      if (isQuitting) return;
      event.preventDefault();
      hideWindow(window);
    });
  }

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(
      join(currentDirectory, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
  return window;
}

function hideWindow(window: BrowserWindow): void {
  if (!window.isFullScreen()) {
    window.hide();
    return;
  }
  // macOS ignores hide() while the window is full screen.
  // https://github.com/desktop/desktop/issues/12838
  window.once("leave-full-screen", () => {
    if (window.isDestroyed()) return;
    window.hide();
  });
  window.setFullScreen(false);
}

function registerLogBridge(): void {
  ipcMain.on(
    LOG_CHANNELS.log,
    (
      event,
      payload: {
        level: LogLevel;
        scopes: readonly LoggerScope[];
        data: LoggerData;
      },
    ) => {
      assertTrustedSender(event);
      rendererLogger.write(payload, payload.scopes);
    },
  );
}

function assertTrustedSender(event: IpcMainEvent): BrowserWindow {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow === null || !windows.has(senderWindow)) {
    throw new Error("Halo rejected IPC from an unknown renderer.");
  }
  return senderWindow;
}

function installMenu(): void {
  const isMac = process.platform === "darwin";
  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: () => checkForUpdates(),
  };
  const openLogsItem: MenuItemConstructorOptions = {
    label: "Open Logs",
    click: () => {
      // oxlint-disable-next-line typescript/no-floating-promises -- Electron menu callbacks cannot await command work.
      void openLogs();
    },
  };
  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      {
        label: shortcuts.newChat.label,
        accelerator: shortcuts.newChat.accelerator,
        click: () =>
          BrowserWindow.getFocusedWindow()?.webContents.send(
            SHORTCUT_CHANNEL,
            "newChat",
          ),
      },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit" },
    ],
  };
  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      {
        label: shortcuts.shortcutMenu.label,
        accelerator: shortcuts.shortcutMenu.accelerator,
        click: () =>
          BrowserWindow.getFocusedWindow()?.webContents.send(
            SHORTCUT_CHANNEL,
            "shortcutMenu",
          ),
      },
      { type: "separator" },
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      // Electron's zoomIn role binds CommandOrControl+Plus; browsers also use =.
      {
        role: "zoomIn",
        accelerator: "CommandOrControl+=",
        visible: false,
      },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
  const menus: MenuItemConstructorOptions[] = [
    fileMenu,
    { role: "editMenu" },
    viewMenu,
    { role: "windowMenu" },
  ];
  if (isMac) {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            checkForUpdatesItem,
            openLogsItem,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        ...menus,
      ]),
    );
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...menus,
      { label: "Help", submenu: [checkForUpdatesItem, openLogsItem] },
    ]),
  );
}

async function openLogs(): Promise<void> {
  const errorMessage = await shell.openPath(applicationConfig.logsDir);
  if (errorMessage === "") return;
  logger.error({ event: "open-logs-failed", error: errorMessage });
  if (mainWindow === undefined) return;
  await dialog.showMessageBox(mainWindow, {
    type: "error",
    title: "Open Logs",
    message: "Could not open the logs folder",
    detail: `${errorMessage}\n\n${applicationConfig.logsDir}`,
  });
}

function ignoreClosedStdioPipe(stream: NodeJS.WriteStream) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") return;
    throw error;
  });
}
