import crypto from "node:crypto";
import os from "node:os";
import * as errore from "errore";
import {
  createHaloClient,
  type DeviceAdvertisement,
  type DeviceRequest,
  type HaloClient,
  type HaloRpcTransport,
} from "@get-halo/client";
import type { LoggerApi } from "@get-halo/logger";
import { DeviceFiles } from "./DeviceFiles.js";
import type { DeviceSettings } from "./DeviceSettings.js";

export type DeviceHostStatus =
  | { state: "disabled" }
  | { state: "connecting" }
  | { state: "online"; since: number }
  | { state: "offline"; message: string; retryAt: number };

class DeviceHostConnectionError extends errore.createTaggedError({
  name: "DeviceHostConnectionError",
  message: "This computer could not reach the workspace: $detail",
}) {}

const minimumRetryMs = 1_000;
const maximumRetryMs = 30_000;

/**
 * Keeps this computer connected to its workspace while it is enabled and
 * runs the requests the workspace agent sends to it. The host supplies the
 * workspace transport and the saved settings.
 */
export class DeviceHost {
  private readonly getTransport: () => Promise<
    HaloRpcTransport | Error | undefined
  >;
  private readonly logger: Pick<LoggerApi, "info" | "warn">;
  private readonly home: string;
  private settings: DeviceSettings;
  private connection: AbortController | undefined;
  private readonly stopped = new AbortController();
  private running: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private current: DeviceHostStatus = { state: "disabled" };

  constructor(ctx: {
    settings: DeviceSettings;
    getTransport: () => Promise<HaloRpcTransport | Error | undefined>;
    logger: Pick<LoggerApi, "info" | "warn">;
    home?: string;
  }) {
    this.settings = ctx.settings;
    this.getTransport = ctx.getTransport;
    this.logger = ctx.logger;
    this.home = ctx.home ?? os.homedir();
  }

  get status() {
    return this.current;
  }

  start() {
    this.running ??= this.run();
  }

  /** Applies new settings by reconnecting with a fresh advertisement. */
  update(settings: DeviceSettings) {
    this.settings = settings;
    this.reconnect();
  }

  /** Reconnects now, for example after signing in again. */
  reconnect() {
    this.connection?.abort();
    this.wake?.();
  }

  async stop() {
    this.stopped.abort();
    this.connection?.abort();
    this.wake?.();
    await this.running;
  }

  private advertisement(): DeviceAdvertisement {
    return {
      id: this.settings.id,
      name: this.settings.name,
      platform: process.platform,
      home: this.home,
      files: this.settings.files,
    };
  }

  private async run() {
    let retryMs = minimumRetryMs;
    while (!this.stopped.signal.aborted) {
      if (!this.settings.enabled) {
        this.current = { state: "disabled" };
        await this.sleep(undefined);
        continue;
      }
      this.current = { state: "connecting" };
      const served = await this.serveOnce(() => {
        retryMs = minimumRetryMs;
      });
      if (this.stopped.signal.aborted) break;
      if (served instanceof Error) {
        this.logger.warn({ event: "device-connection-lost", error: served });
        this.current = {
          state: "offline",
          message: served.message,
          retryAt: Date.now() + retryMs,
        };
        await this.sleep(retryMs);
        retryMs = Math.min(retryMs * 2, maximumRetryMs);
      }
    }
    this.current = { state: "disabled" };
  }

  /** Serves one connection until it ends. Settings changes end it cleanly. */
  private async serveOnce(onOnline: () => void) {
    const transport = await this.getTransport();
    if (transport instanceof Error)
      return new DeviceHostConnectionError({
        detail: transport.message,
        cause: transport,
      });
    if (transport === undefined)
      return new DeviceHostConnectionError({ detail: "Halo is signed out" });
    using cleanup = new errore.DisposableStack();
    const connection = new AbortController();
    this.connection = connection;
    cleanup.defer(() => connection.abort());
    const signal = AbortSignal.any([connection.signal, this.stopped.signal]);
    let lost: Error | undefined;
    const client = createHaloClient({
      transport,
      websocket: { clientId: crypto.randomUUID(), signal },
      onDisconnect: (error) => {
        lost = error;
        connection.abort();
      },
    });
    const requests = await client.devices
      .serve({ device: this.advertisement() }, { signal })
      .catch(
        (cause) => new DeviceHostConnectionError({ detail: "open", cause }),
      );
    if (requests instanceof Error)
      return signal.aborted && lost === undefined ? undefined : requests;
    this.current = { state: "online", since: Date.now() };
    this.logger.info({ event: "device-online", name: this.settings.name });
    onOnline();
    const files = new DeviceFiles({ ...this.settings.files, home: this.home });
    const served = await (async () => {
      for await (const request of requests)
        this.handle({ client, files, request }).catch((cause: unknown) =>
          this.logger.warn({
            event: "device-request-failed",
            error: new DeviceHostConnectionError({ detail: "request", cause }),
          }),
        );
    })().catch(
      (cause) => new DeviceHostConnectionError({ detail: "stream", cause }),
    );
    if (connection.signal.aborted && lost === undefined) return;
    if (lost !== undefined)
      return new DeviceHostConnectionError({
        detail: lost.message,
        cause: lost,
      });
    if (served instanceof Error) return served;
    return new DeviceHostConnectionError({
      detail: "the workspace closed the connection",
    });
  }

  private async handle(input: {
    client: HaloClient;
    files: DeviceFiles;
    request: DeviceRequest;
  }) {
    const { client, files, request } = input;
    const result = await files.run(request.operation);
    const response =
      result instanceof Error
        ? {
            deviceId: this.settings.id,
            callId: request.callId,
            ok: false as const,
            error: {
              code: String(result.code),
              message: String(result.detail),
            },
          }
        : {
            deviceId: this.settings.id,
            callId: request.callId,
            ok: true as const,
            result,
          };
    // Results go over HTTP, so they can arrive after the socket reconnects.
    const sent = await client.devices
      .respond(response)
      .catch(
        (cause) => new DeviceHostConnectionError({ detail: "respond", cause }),
      );
    if (sent instanceof Error)
      this.logger.warn({ event: "device-response-failed", error: sent });
  }

  private async sleep(ms: number | undefined) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = ms === undefined ? undefined : setTimeout(done, ms);
      this.wake = done;
      if (this.stopped.signal.aborted) done();
    });
  }
}
