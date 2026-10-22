import {
  DeviceHost,
  DeviceSettingsStore,
  type DevicePermissions,
  type DeviceSettings,
  type DeviceSettingsUpdate,
} from "@get-halo/device-host";
import type {
  DeviceFileAccess,
  DevicePermissionRequest,
  HaloRpcTransport,
} from "@get-halo/client";
import type { Logger } from "@get-halo/logger";
import type { LocalDeviceInfo } from "@get-halo/web/HostApi";
import type { HaloRpcConnection } from "../../shared/HaloRpcConnection.js";

/**
 * Makes the computer Halo runs on available to the workspace agent. Owns the
 * saved device settings and the device's connection. The person answers
 * permission requests on chat cards, which call allow.
 */
export class LocalDevice {
  private readonly store: DeviceSettingsStore;
  private readonly host: DeviceHost;
  private readonly logger: Logger;
  private settings: DeviceSettings;

  private constructor(ctx: {
    store: DeviceSettingsStore;
    settings: DeviceSettings;
    getConnection: () => Promise<HaloRpcConnection | Error | undefined>;
    logger: Logger;
  }) {
    this.store = ctx.store;
    this.settings = ctx.settings;
    this.logger = ctx.logger;
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
      savePermissions: async (permissions) =>
        await this.savePermissions(permissions),
    });
  }

  static async start(ctx: {
    dataDir: string;
    getConnection: () => Promise<HaloRpcConnection | Error | undefined>;
    logger: Logger;
  }) {
    const store = new DeviceSettingsStore({ dataDir: ctx.dataDir });
    const settings = await store.read();
    if (settings instanceof Error) return settings;
    const device = new LocalDevice({ ...ctx, store, settings });
    device.host.start();
    return device;
  }

  info(): LocalDeviceInfo {
    return { id: this.settings.id, name: this.settings.name };
  }

  /** Records the person's answer to a permission card shown on this computer. */
  async allow(input: {
    request: DevicePermissionRequest;
    access: DeviceFileAccess;
  }) {
    await this.host.allow(input);
  }

  /** Reconnects with fresh credentials after signing in or out. */
  reconnect() {
    this.host.reconnect();
  }

  async stop() {
    await this.host.stop();
  }

  private async update(update: DeviceSettingsUpdate) {
    const saved = await this.store.update(update);
    if (saved instanceof Error) return saved;
    this.settings = saved;
    this.host.update(saved);
    return saved;
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
