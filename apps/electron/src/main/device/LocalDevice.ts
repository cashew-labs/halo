import os from "node:os";
import path from "node:path";
import { app, dialog, type BrowserWindow } from "electron";
import {
  DeviceHost,
  DeviceSettingsStore,
  type DeviceAccessAnswer,
  type DeviceAccessRequest,
  type DeviceCommandRequest,
  type DevicePermissions,
  type DeviceSettings,
  type DeviceSettingsUpdate,
} from "@get-halo/device-host";
import type { HaloRpcTransport } from "@get-halo/client";
import type { Logger } from "@get-halo/logger";
import type { LocalDeviceState } from "@get-halo/web/HostApi";
import type { HaloRpcConnection } from "../../shared/HaloRpcConnection.js";

const answers: readonly DeviceAccessAnswer[] = ["write", "read", "deny"];

/**
 * Makes the computer Halo runs on available to the workspace agent. Owns the
 * saved device settings, the access prompt, and the device's connection.
 */
export class LocalDevice {
  private readonly store: DeviceSettingsStore;
  private readonly host: DeviceHost;
  private readonly logger: Logger;
  private readonly getWindow: () => BrowserWindow | undefined;
  private settings: DeviceSettings;

  private constructor(ctx: {
    store: DeviceSettingsStore;
    settings: DeviceSettings;
    getConnection: () => Promise<HaloRpcConnection | Error | undefined>;
    getWindow: () => BrowserWindow | undefined;
    logger: Logger;
  }) {
    this.store = ctx.store;
    this.settings = ctx.settings;
    this.logger = ctx.logger;
    this.getWindow = ctx.getWindow;
    this.host = new DeviceHost({
      settings: ctx.settings,
      logger: ctx.logger,
      getTransport: async () => {
        const connection = await ctx.getConnection();
        if (connection instanceof Error || connection === undefined)
          return connection;
        return {
          origin: connection.origin,
          path: connection.path,
          headers: { authorization: `Bearer ${connection.token}` },
        } satisfies HaloRpcTransport;
      },
      ask: async (request) => await this.ask(request),
      askCommands: async (request) => await this.askCommands(request),
      savePermissions: async (permissions) =>
        await this.savePermissions(permissions),
    });
  }

  static async start(ctx: {
    dataDir: string;
    getConnection: () => Promise<HaloRpcConnection | Error | undefined>;
    getWindow: () => BrowserWindow | undefined;
    logger: Logger;
  }) {
    const store = new DeviceSettingsStore({ dataDir: ctx.dataDir });
    const settings = await store.read();
    if (settings instanceof Error) return settings;
    const device = new LocalDevice({ ...ctx, store, settings });
    device.host.start();
    return device;
  }

  state(): LocalDeviceState {
    return {
      name: this.settings.name,
      enabled: this.settings.enabled,
      files: this.settings.files,
      commands: { allowed: this.settings.commands?.allowed === true },
      status: this.host.status,
    };
  }

  async update(update: DeviceSettingsUpdate) {
    const saved = await this.store.update(update);
    if (saved instanceof Error) return saved;
    this.settings = saved;
    this.host.update(saved);
    return this.state();
  }

  /** Reconnects with fresh credentials after signing in or out. */
  reconnect() {
    this.host.reconnect();
  }

  async stop() {
    await this.host.stop();
  }

  private async ask(request: DeviceAccessRequest): Promise<DeviceAccessAnswer> {
    const window = this.getWindow();
    // Draw attention without taking focus from whatever the person is doing.
    window?.flashFrame(true);
    app.dock?.bounce("informational");
    const verb = request.access === "write" ? "change" : "read";
    const options: Electron.MessageBoxOptions = {
      type: "question",
      message: `Allow Halo to ${verb} files in ${displayPath(request.folder)}?`,
      detail: `The Halo agent asked to ${verb} ${displayPath(request.path)}. Your answer applies to this folder and its subfolders. You can remove it later in Account settings.`,
      buttons: ["Allow read and write", "Allow read only", "Don't allow"],
      defaultId: request.access === "write" ? 0 : 1,
      cancelId: 2,
      noLink: true,
      signal: request.signal,
    };
    const chosen =
      window === undefined
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(window, options);
    window?.flashFrame(false);
    if (request.signal.aborted) return "deny";
    return answers[chosen.response] ?? "deny";
  }

  private async askCommands(request: DeviceCommandRequest): Promise<boolean> {
    const window = this.getWindow();
    window?.flashFrame(true);
    app.dock?.bounce("informational");
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      message: "Allow Halo to run commands on this computer?",
      detail: `The Halo agent wants to run this in ${displayPath(request.cwd)}:\n\n${request.command}\n\nCommands run as you, with your full access, including folders you have not allowed. Halo remembers your answer; you can remove it later in Account settings.`,
      buttons: ["Allow commands", "Don't allow"],
      // Running commands is broad access, so Return does not allow it.
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      signal: request.signal,
    };
    const chosen =
      window === undefined
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(window, options);
    window?.flashFrame(false);
    return !request.signal.aborted && chosen.response === 0;
  }

  private async savePermissions(permissions: DevicePermissions) {
    const saved = await this.update({
      files: { grants: permissions.grants },
      commands: { allowed: permissions.commandsAllowed },
    });
    // The grant still applies until the app restarts.
    if (saved instanceof Error)
      this.logger.warn({ event: "device-grant-save-failed", error: saved });
  }
}

function displayPath(target: string) {
  const relative = path.relative(os.homedir(), target);
  if (relative === "") return "your home folder";
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? target
    : `~/${relative}`;
}
