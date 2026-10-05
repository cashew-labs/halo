import { app, autoUpdater, dialog, type BrowserWindow } from "electron";
import type { ElectronConfig } from "@get-halo/config/electron";
import type { AppInfo, AppUpdateStatus } from "@get-halo/web/HostApi";
import * as errore from "errore";
import path from "node:path";
import type { LoggerApi } from "@get-halo/logger";
import { MacAppUpdater } from "./MacAppUpdater.js";
import { updateElectronApp } from "update-electron-app";

/** How often packaged macOS/Windows builds poll update.electronjs.org. */
const UPDATE_POLL_INTERVAL = "10 minutes";

class UpdateNotReadyError extends errore.createTaggedError({
  name: "UpdateNotReadyError",
  message: "No downloaded update to install",
}) {}

export class AppUpdates {
  private updateStatus: AppUpdateStatus = {
    state: "disabled",
    reason: "Updates start after launch",
  };
  private updatesEnabled = false;
  private manualCheckPending = false;
  private macUpdater: MacAppUpdater | undefined;
  private readonly config: ElectronConfig["updates"];
  private readonly getWindow: () => BrowserWindow | undefined;
  private readonly logger: LoggerApi;
  private readonly onInstallCancelled: () => void;

  constructor(ctx: {
    config: ElectronConfig["updates"];
    getWindow: () => BrowserWindow | undefined;
    logger: LoggerApi;
    onInstallCancelled(): void;
  }) {
    this.config = ctx.config;
    this.getWindow = ctx.getWindow;
    this.logger = ctx.logger;
    this.onInstallCancelled = ctx.onInstallCancelled;
  }

  close() {
    this.macUpdater?.close();
  }

  getAppInfo(): AppInfo {
    return {
      version: app.getVersion(),
      update: this.updateStatus,
    };
  }

  start(): void {
    if (!this.config.enabled) {
      this.updateStatus = {
        state: "disabled",
        reason: this.config.reason,
      };
      return;
    }
    if (process.platform === "linux") {
      this.updateStatus = {
        state: "disabled",
        reason: "Linux installs update manually from GitHub Releases",
      };
      return;
    }

    this.updatesEnabled = true;
    this.updateStatus = { state: "idle" };
    if (process.platform === "darwin") {
      this.macUpdater = new MacAppUpdater({
        native: autoUpdater,
        version: app.getVersion(),
        feedUrl: `https://update.electronjs.org/cashew-labs/halo/darwin-${process.arch}/${app.getVersion()}`,
        statePath: path.join(
          app.getPath("home"),
          "Library/Caches/com.saffronhealth.halo.ShipIt/ShipItState.plist",
        ),
        bundlePath: path.resolve(process.execPath, "../../.."),
        logger: this.logger,
        onStatus: (status) => {
          this.updateStatus = status;
          if (!this.manualCheckPending || status.state === "checking") return;
          this.manualCheckPending = false;
          if (status.state !== "idle" && status.state !== "error") return;
          void dialog
            .showMessageBox({
              type: status.state === "error" ? "error" : "info",
              title: "Check for Updates",
              message:
                status.state === "error"
                  ? "Could not check for updates"
                  : "Halo is up to date",
              detail:
                status.state === "error"
                  ? status.message
                  : `Version ${app.getVersion()}`,
            })
            .catch(console.error);
        },
        onReady: (version) => this.showUpdateReadyDialog(version),
        onInstallCancelled: this.onInstallCancelled,
      });
      this.macUpdater.start();
      return;
    }

    autoUpdater.on("checking-for-update", () => {
      this.updateStatus = { state: "checking" };
    });
    autoUpdater.on("update-available", () => {
      this.manualCheckPending = false;
      this.updateStatus = { state: "available" };
    });
    autoUpdater.on("update-downloaded", (_event, _notes, releaseName) => {
      this.manualCheckPending = false;
      this.updateStatus = {
        state: "downloaded",
        version: releaseName,
      };
    });
    autoUpdater.on("update-not-available", () => {
      this.updateStatus = { state: "idle" };
      if (!this.manualCheckPending) return;
      this.manualCheckPending = false;
      // oxlint-disable-next-line typescript/no-floating-promises -- Electron owns this synchronous updater event callback; the dialog is informational.
      void dialog.showMessageBox({
        type: "info",
        title: "Check for Updates",
        message: "Halo is up to date",
        detail: `Version ${app.getVersion()}`,
      });
    });
    autoUpdater.on("error", (error) => {
      this.updateStatus = {
        state: "error",
        message: error.message,
      };
      if (!this.manualCheckPending) return;
      this.manualCheckPending = false;
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
        this.showUpdateReadyDialog(info.releaseName);
      },
    });
  }

  checkForUpdates(): void {
    if (!this.updatesEnabled) {
      const detail =
        this.updateStatus.state === "disabled"
          ? this.updateStatus.reason
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

    if (this.updateStatus.state === "downloaded") {
      this.showUpdateReadyDialog(this.updateStatus.version);
      return;
    }

    if (
      this.updateStatus.state === "available" ||
      this.updateStatus.state === "checking"
    ) {
      // oxlint-disable-next-line typescript/no-floating-promises -- This command only opens an informational dialog and has no follow-up work.
      void dialog.showMessageBox({
        type: "info",
        title: "Check for Updates",
        message:
          this.updateStatus.state === "checking"
            ? "Checking for updates…"
            : "Downloading update…",
      });
      return;
    }

    this.manualCheckPending = true;
    this.beginUpdateCheck();
  }

  async checkForAppUpdate() {
    if (this.macUpdater !== undefined) {
      // Acknowledge the command immediately so clients can poll download status.
      this.beginUpdateCheck();
      return;
    }
    if (!this.updatesEnabled) return;
    if (
      this.updateStatus.state === "checking" ||
      this.updateStatus.state === "available" ||
      this.updateStatus.state === "downloaded"
    ) {
      return;
    }

    this.manualCheckPending = false;
    this.beginUpdateCheck();
  }

  async installAppUpdate() {
    if (this.macUpdater !== undefined) return await this.macUpdater.install();
    if (this.updateStatus.state !== "downloaded")
      return new UpdateNotReadyError();
    autoUpdater.quitAndInstall();
  }

  private beginUpdateCheck(): void {
    if (this.macUpdater !== undefined) {
      void this.macUpdater
        .check()
        .then((error) => {
          if (error instanceof Error)
            this.logger.warn({ event: "update-check-failed", error });
        })
        .catch(console.error);
      return;
    }
    this.updateStatus = { state: "checking" };
    autoUpdater.checkForUpdates();
  }

  private showUpdateReadyDialog(version: string): void {
    const layout = updateReadyButtonLayout(process.platform);
    const window = this.getWindow();
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
    void shown
      .then(({ response }) => {
        if (response !== layout.updateIndex) return;
        void this.installAppUpdate()
          .then((error) => {
            if (error instanceof Error)
              this.logger.warn({ event: "update-install-failed", error });
          })
          .catch(console.error);
      })
      .catch(console.error);
  }
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
