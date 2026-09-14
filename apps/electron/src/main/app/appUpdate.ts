import { app, autoUpdater, dialog, type BrowserWindow } from "electron";
import type { ElectronConfig } from "@get-halo/config/electron";
import * as errore from "errore";
import { updateElectronApp } from "update-electron-app";
import type { AppInfo, AppUpdateStatus } from "../../shared/desktop.js";

/** How often packaged macOS/Windows builds poll update.electronjs.org. */
const UPDATE_POLL_INTERVAL = "10 minutes";

class UpdateNotReadyError extends errore.createTaggedError({
  name: "UpdateNotReadyError",
  message: "No downloaded update to install",
}) {}

let updateStatus: AppUpdateStatus = {
  state: "disabled",
  reason: "Updates start after launch",
};
let updatesEnabled = false;
let manualCheckPending = false;
let getWindow: () => BrowserWindow | undefined = () => undefined;

export function getAppInfo(): AppInfo {
  return {
    version: app.getVersion(),
    update: updateStatus,
  };
}

export function startAppUpdates(args: {
  config: ElectronConfig["updates"];
  getWindow: () => BrowserWindow | undefined;
}): void {
  getWindow = args.getWindow;
  if (!args.config.enabled) {
    updateStatus = {
      state: "disabled",
      reason: args.config.reason,
    };
    return;
  }
  if (process.platform === "linux") {
    updateStatus = {
      state: "disabled",
      reason: "Linux installs update manually from GitHub Releases",
    };
    return;
  }

  updatesEnabled = true;
  updateStatus = { state: "idle" };

  autoUpdater.on("checking-for-update", () => {
    updateStatus = { state: "checking" };
  });
  autoUpdater.on("update-available", () => {
    manualCheckPending = false;
    updateStatus = { state: "available" };
  });
  autoUpdater.on("update-downloaded", (_event, _notes, releaseName) => {
    manualCheckPending = false;
    updateStatus = {
      state: "downloaded",
      version: releaseName,
    };
  });
  autoUpdater.on("update-not-available", () => {
    updateStatus = { state: "idle" };
    if (!manualCheckPending) return;
    manualCheckPending = false;
    // oxlint-disable-next-line typescript/no-floating-promises -- Electron owns this synchronous updater event callback; the dialog is informational.
    void dialog.showMessageBox({
      type: "info",
      title: "Check for Updates",
      message: "Halo is up to date",
      detail: `Version ${app.getVersion()}`,
    });
  });
  autoUpdater.on("error", (error) => {
    updateStatus = {
      state: "error",
      message: error.message,
    };
    if (!manualCheckPending) return;
    manualCheckPending = false;
    // oxlint-disable-next-line typescript/no-floating-promises -- Electron owns this synchronous updater event callback; the dialog is informational.
    void dialog.showMessageBox({
      type: "error",
      title: "Check for Updates",
      message: "Could not check for updates",
      detail: error.message,
    });
  });

  updateElectronApp({
    updateInterval: UPDATE_POLL_INTERVAL,
    onNotifyUser: (info) => {
      showUpdateReadyDialog(info.releaseName);
    },
  });
}

export function checkForUpdates(): void {
  if (!updatesEnabled) {
    const detail =
      updateStatus.state === "disabled"
        ? updateStatus.reason
        : "Updates are not available.";
    // oxlint-disable-next-line typescript/no-floating-promises -- This command only opens an informational dialog and has no follow-up work.
    void dialog.showMessageBox({
      type: "info",
      title: "Check for Updates",
      message: "Updates are not available",
      detail,
    });
    return;
  }

  if (updateStatus.state === "downloaded") {
    showUpdateReadyDialog(updateStatus.version);
    return;
  }

  if (updateStatus.state === "available" || updateStatus.state === "checking") {
    // oxlint-disable-next-line typescript/no-floating-promises -- This command only opens an informational dialog and has no follow-up work.
    void dialog.showMessageBox({
      type: "info",
      title: "Check for Updates",
      message:
        updateStatus.state === "checking"
          ? "Checking for updates…"
          : "Downloading update…",
    });
    return;
  }

  manualCheckPending = true;
  updateStatus = { state: "checking" };
  autoUpdater.checkForUpdates();
}

export function installAppUpdate() {
  if (updateStatus.state !== "downloaded") return new UpdateNotReadyError();
  autoUpdater.quitAndInstall();
}

function showUpdateReadyDialog(version: string): void {
  const layout = updateReadyButtonLayout(process.platform);
  const window = getWindow();
  const options: Electron.MessageBoxOptions = {
    type: "info",
    title: "Update Halo",
    message: `Halo ${version} is ready`,
    detail: "Restart to install the update.",
    buttons: [...layout.buttons],
    defaultId: layout.updateIndex,
    cancelId: layout.laterIndex,
    noLink: true,
  };
  const shown =
    window === undefined
      ? dialog.showMessageBox(options)
      : dialog.showMessageBox(window, options);
  // oxlint-disable-next-line typescript/no-floating-promises -- The modeless dialog owns this user interaction beyond the caller's lifetime.
  void shown.then(({ response }) => {
    if (response !== layout.updateIndex) return;
    autoUpdater.quitAndInstall();
  });
}

function updateReadyButtonLayout(platform: NodeJS.Platform) {
  // macOS draws the first button on the right as the default action.
  if (platform === "darwin") {
    return {
      buttons: ["Update", "Later"] as const,
      updateIndex: 0,
      laterIndex: 1,
    };
  }
  return {
    buttons: ["Later", "Update"] as const,
    updateIndex: 1,
    laterIndex: 0,
  };
}
