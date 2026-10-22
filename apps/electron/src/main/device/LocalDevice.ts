import crypto from "node:crypto";
import * as errore from "errore";
import type { BrowserWindow } from "electron";
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
import type {
  LocalDeviceState,
  LocalDeviceAccessRequest,
  LocalDeviceAccessAnswer,
} from "@get-halo/web/HostApi";
import { DEVICE_ACCESS_CHANNEL } from "../../shared/desktop.js";
import type { HaloRpcConnection } from "../../shared/HaloRpcConnection.js";

class DeviceAccessResponseError extends errore.createTaggedError({
  name: "DeviceAccessResponseError",
  message:
    "This permission request is no longer available or the answer does not match it.",
}) {}

/**
 * Makes the computer Halo runs on available to the workspace agent. Owns the
 * saved device settings, the access prompt, and the device's connection.
 */
export class LocalDevice {
  // Requests stay beside their tool activity for the lifetime of this desktop.
  private readonly requests = new Map<string, LocalDeviceAccessRequest>();
  private readonly answers = new Map<
    string,
    (answer: LocalDeviceAccessAnswer) => void
  >();
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
    for (const request of this.requests.values()) {
      if (!["read", "write", "allowed"].includes(request.status)) continue;
      const prompt = request.prompt;
      const allowed =
        prompt.kind === "commands"
          ? saved.commands?.allowed === true
          : saved.files.grants.some((grant) => grant.path === prompt.folder);
      if (!allowed) request.status = "removed";
    }
    this.publishRequests();
    return this.state();
  }

  /** Reconnects with fresh credentials after signing in or out. */
  reconnect() {
    this.host.reconnect();
  }

  async stop() {
    for (const answer of this.answers.values()) answer("deny");
    await this.host.stop();
  }

  accessRequests() {
    return [...this.requests.values()];
  }

  respondToAccessRequest(input: {
    requestId: string;
    answer: LocalDeviceAccessAnswer;
  }) {
    const request = this.requests.get(input.requestId);
    const answer = this.answers.get(input.requestId);
    if (
      request === undefined ||
      answer === undefined ||
      request.status !== "pending"
    )
      return new DeviceAccessResponseError();
    if (
      input.answer !== "deny" &&
      (request.prompt.kind === "commands"
        ? input.answer !== "allowCommands"
        : input.answer === "allowCommands")
    )
      return new DeviceAccessResponseError();
    answer(input.answer);
  }

  private publishRequests() {
    this.getWindow()?.webContents.send(
      DEVICE_ACCESS_CHANNEL,
      this.accessRequests(),
    );
  }

  private async ask(request: DeviceAccessRequest): Promise<DeviceAccessAnswer> {
    const answer = await this.requestAccess({
      context: request.context,
      signal: request.signal,
      prompt: {
        kind: "files",
        folder: request.folder,
        path: request.path,
        access: request.access,
      },
    });
    return answer === "read" || answer === "write" ? answer : "deny";
  }

  private async askCommands(request: DeviceCommandRequest) {
    return (
      (await this.requestAccess({
        context: request.context,
        signal: request.signal,
        prompt: {
          kind: "commands",
          command: request.command,
          cwd: request.cwd,
        },
      })) === "allowCommands"
    );
  }

  private async requestAccess(input: {
    context: DeviceAccessRequest["context"];
    signal: AbortSignal;
    prompt: LocalDeviceAccessRequest["prompt"];
  }): Promise<LocalDeviceAccessAnswer> {
    if (input.signal.aborted) return "deny";
    const { sessionId, toolCallId } = input.context ?? {};
    if (sessionId === undefined || toolCallId === undefined) {
      this.logger.warn({ event: "device-permission-without-chat" });
      return "deny";
    }
    const request: LocalDeviceAccessRequest = {
      id: crypto.randomUUID(),
      sessionId,
      toolCallId,
      status: "pending",
      prompt: input.prompt,
    };
    this.requests.set(request.id, request);
    return await new Promise<LocalDeviceAccessAnswer>((resolve) => {
      const finish = (answer: LocalDeviceAccessAnswer) => {
        this.answers.delete(request.id);
        input.signal.removeEventListener("abort", cancel);
        request.status = input.signal.aborted
          ? "cancelled"
          : answer === "deny"
            ? "denied"
            : answer === "allowCommands"
              ? "allowed"
              : answer;
        this.publishRequests();
        resolve(answer);
      };
      const cancel = () => finish("deny");
      this.answers.set(request.id, finish);
      input.signal.addEventListener("abort", cancel, { once: true });
      this.publishRequests();
    });
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
