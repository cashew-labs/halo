import { dialog, type BrowserWindow } from "electron";
import {
  DeviceHost,
  DeviceSettingsStore,
  type DeviceSettings,
  type DeviceSettingsUpdate,
} from "@get-halo/device-host";
import type { HaloRpcTransport } from "@get-halo/client";
import type { Logger } from "@get-halo/logger";
import type { LocalDeviceState } from "@get-halo/web/HostApi";
import type { HaloRpcConnection } from "../../shared/HaloRpcConnection.js";

/**
 * Lets the workspace agent use this computer while Halo runs. Owns the saved
 * device settings and the device's workspace connection.
 */
export class LocalDevice {
  private readonly store: DeviceSettingsStore;
  private readonly host: DeviceHost;
  private settings: DeviceSettings;

  private constructor(ctx: {
    store: DeviceSettingsStore;
    settings: DeviceSettings;
    host: DeviceHost;
  }) {
    this.store = ctx.store;
    this.settings = ctx.settings;
    this.host = ctx.host;
  }

  static async start(ctx: {
    dataDir: string;
    getConnection: () => Promise<HaloRpcConnection | Error | undefined>;
    logger: Logger;
  }) {
    const store = new DeviceSettingsStore({ dataDir: ctx.dataDir });
    const settings = await store.read();
    if (settings instanceof Error) return settings;
    const host = new DeviceHost({
      settings,
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
    });
    host.start();
    return new LocalDevice({ store, settings, host });
  }

  state(): LocalDeviceState {
    return {
      name: this.settings.name,
      enabled: this.settings.enabled,
      files: this.settings.files,
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

  async addFolder(window: BrowserWindow | undefined) {
    const options: Electron.OpenDialogOptions = {
      title: "Share a folder with Halo",
      buttonLabel: "Share folder",
      properties: ["openDirectory", "createDirectory"],
    };
    const chosen =
      window === undefined
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
    const folder = chosen.filePaths[0];
    if (chosen.canceled || folder === undefined) return this.state();
    const roots = this.settings.files.roots.includes(folder)
      ? this.settings.files.roots
      : [...this.settings.files.roots, folder];
    return await this.update({ files: { ...this.settings.files, roots } });
  }

  /** Reconnects with fresh credentials after signing in or out. */
  reconnect() {
    this.host.reconnect();
  }

  async stop() {
    await this.host.stop();
  }
}
