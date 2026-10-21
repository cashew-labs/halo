import crypto from "node:crypto";
import * as errore from "errore";
import { Stream } from "@get-halo/shared/Stream";
import type {
  DeviceAdvertisement,
  DeviceOperation,
  DeviceOperationOutput,
  DeviceOperationResult,
  DeviceRequest,
  DeviceResponse,
  DeviceSummary,
} from "@get-halo/client";

export class DeviceNotFoundError extends errore.createTaggedError({
  name: "DeviceNotFoundError",
  message:
    'No device named "$device" has connected to this workspace. Connected devices: $known. Call tools.devices.list() to see them.',
}) {}
export class DeviceAmbiguousError extends errore.createTaggedError({
  name: "DeviceAmbiguousError",
  message: 'Several devices are named "$device". Use a device ID: $ids',
}) {}
export class DeviceOfflineError extends errore.createTaggedError({
  name: "DeviceOfflineError",
  message:
    'Device "$device" is offline. It was last seen $lastSeen. Halo must be open on that computer.',
}) {}
export class DeviceDisconnectedError extends errore.createTaggedError({
  name: "DeviceDisconnectedError",
  message:
    'Device "$device" disconnected before $operation finished. The result is unknown; check before retrying.',
}) {}
export class DeviceTimeoutError extends errore.createTaggedError({
  name: "DeviceTimeoutError",
  message:
    'Device "$device" did not finish $operation within $seconds seconds. The result is unknown; check before retrying.',
}) {}
export class DeviceOperationError extends errore.createTaggedError({
  name: "DeviceOperationError",
  message: 'Device "$device" could not run $operation ($code): $detail',
}) {}
export class DeviceCallNotFoundError extends errore.createTaggedError({
  name: "DeviceCallNotFoundError",
  message: "Device call $callId is no longer pending",
}) {}
export class DeviceCallAbortedError extends errore.createTaggedError({
  name: "DeviceCallAbortedError",
  message: "Device $operation was cancelled",
  extends: errore.AbortError,
}) {}

const deviceErrors = [
  DeviceNotFoundError,
  DeviceAmbiguousError,
  DeviceOfflineError,
  DeviceDisconnectedError,
  DeviceTimeoutError,
  DeviceOperationError,
  DeviceCallAbortedError,
];

/** Finds the device's own explanation inside a wrapped tool error. */
export function deviceFailure(error: Error): Error {
  for (let current: unknown = error; current instanceof Error;) {
    if (deviceErrors.some((type) => current instanceof type)) return current;
    current = current.cause;
  }
  return error;
}

type DeviceConnection = {
  requests: Stream<DeviceRequest>;
  closed: AbortController;
};

type KnownDevice = {
  advertisement: DeviceAdvertisement;
  connection: DeviceConnection | undefined;
  lastSeenAt: number;
  disconnectTimer?: ReturnType<typeof setTimeout>;
};

type PendingCall = {
  deviceId: string;
  operation: DeviceOperation["type"];
  settle: (outcome: DeviceOperationOutput | Error) => void;
};

/**
 * Routes workspace tool calls to the person's connected computers. A device
 * opens a request stream with serve and answers each request with respond.
 * Devices enforce their own folder and access settings; this service only
 * delivers requests and results.
 */
export class DeviceService {
  private readonly devices = new Map<string, KnownDevice>();
  private readonly calls = new Map<string, PendingCall>();
  private readonly disconnectGraceMs: number;
  private readonly callTimeoutMs: number;

  constructor(
    ctx: { disconnectGraceMs?: number; callTimeoutMs?: number } = {},
  ) {
    // A socket rotation or brief network loss should not fail running calls.
    this.disconnectGraceMs = ctx.disconnectGraceMs ?? 20_000;
    this.callTimeoutMs = ctx.callTimeoutMs ?? 60_000;
  }

  list(): DeviceSummary[] {
    return [...this.devices.values()].map((device) => ({
      ...device.advertisement,
      online: device.connection !== undefined,
      lastSeenAt: device.lastSeenAt,
    }));
  }

  async *serve(input: {
    device: DeviceAdvertisement;
    signal?: AbortSignal;
  }): AsyncGenerator<DeviceRequest, void> {
    const { device } = input;
    const previous = this.devices.get(device.id);
    // The newest connection wins, such as after a socket rotation.
    previous?.connection?.closed.abort();
    clearTimeout(previous?.disconnectTimer);
    const connection: DeviceConnection = {
      requests: new Stream(),
      closed: new AbortController(),
    };
    using requests = connection.requests.consume({
      abortSignal:
        input.signal === undefined
          ? connection.closed.signal
          : AbortSignal.any([input.signal, connection.closed.signal]),
    });
    this.devices.set(device.id, {
      advertisement: device,
      connection,
      lastSeenAt: Date.now(),
    });
    try {
      for await (const request of requests) yield request;
    } finally {
      const known = this.devices.get(device.id);
      if (known?.connection === connection) {
        known.connection = undefined;
        known.lastSeenAt = Date.now();
        known.disconnectTimer = setTimeout(
          () => this.failPendingCalls(device.id),
          this.disconnectGraceMs,
        );
        known.disconnectTimer.unref();
      }
    }
  }

  respond(response: DeviceResponse): void | DeviceCallNotFoundError {
    const call = this.calls.get(response.callId);
    if (call === undefined || call.deviceId !== response.deviceId)
      return new DeviceCallNotFoundError({ callId: response.callId });
    this.calls.delete(response.callId);
    const device = this.devices.get(call.deviceId);
    if (device !== undefined) device.lastSeenAt = Date.now();
    call.settle(
      response.ok
        ? response.result
        : new DeviceOperationError({
            device: device?.advertisement.name ?? call.deviceId,
            operation: call.operation,
            detail: response.error.message,
            code: response.error.code,
          }),
    );
  }

  /** Finds one device by its ID or its name, ignoring case. */
  resolve(
    device: string,
  ): DeviceSummary | DeviceNotFoundError | DeviceAmbiguousError {
    const devices = this.list();
    const byId = devices.find((candidate) => candidate.id === device);
    if (byId !== undefined) return byId;
    const named = devices.filter(
      (candidate) => candidate.name.toLowerCase() === device.toLowerCase(),
    );
    // A renamed or reinstalled computer may leave an offline record behind.
    const online = named.filter((candidate) => candidate.online);
    const matches = online.length > 0 ? online : named;
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1)
      return new DeviceAmbiguousError({
        device,
        ids: matches.map((candidate) => candidate.id).join(", "),
      });
    return new DeviceNotFoundError({
      device,
      known:
        devices
          .filter((candidate) => candidate.online)
          .map((candidate) => candidate.name)
          .join(", ") || "none",
    });
  }

  async call<T extends DeviceOperation>(input: {
    device: string;
    operation: T;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<DeviceOperationResult[T["type"]] | Error> {
    const summary = this.resolve(input.device);
    if (summary instanceof Error) return summary;
    const connection = this.devices.get(summary.id)?.connection;
    if (connection === undefined)
      return new DeviceOfflineError({
        device: summary.name,
        lastSeen: new Date(summary.lastSeenAt).toISOString(),
      });
    if (input.signal?.aborted)
      return new DeviceCallAbortedError({ operation: input.operation.type });
    const callId = crypto.randomUUID();
    const timeoutMs = input.timeoutMs ?? this.callTimeoutMs;
    const result = await new Promise<DeviceOperationOutput | Error>(
      (resolve) => {
        const settle = (value: DeviceOperationOutput | Error) => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", abort);
          this.calls.delete(callId);
          resolve(value);
        };
        const abort = () =>
          settle(
            new DeviceCallAbortedError({
              operation: input.operation.type,
              cause: input.signal?.reason,
            }),
          );
        const timer = setTimeout(
          () =>
            settle(
              new DeviceTimeoutError({
                device: summary.name,
                operation: input.operation.type,
                seconds: String(Math.round(timeoutMs / 1000)),
              }),
            ),
          timeoutMs,
        );
        input.signal?.addEventListener("abort", abort, { once: true });
        this.calls.set(callId, {
          deviceId: summary.id,
          operation: input.operation.type,
          settle,
        });
        connection.requests.append({
          callId,
          operation: input.operation,
        });
      },
    );
    if (result instanceof Error) return result;
    // SAFETY: The device answers each operation with its result type.
    return result as DeviceOperationResult[T["type"]];
  }

  close() {
    for (const device of this.devices.values()) {
      device.connection?.closed.abort();
      clearTimeout(device.disconnectTimer);
    }
    for (const [callId, call] of this.calls) {
      this.calls.delete(callId);
      call.settle(
        new DeviceDisconnectedError({
          device: call.deviceId,
          operation: call.operation,
        }),
      );
    }
  }

  private failPendingCalls(deviceId: string) {
    const device = this.devices.get(deviceId);
    if (device?.connection !== undefined) return;
    for (const call of this.calls.values()) {
      if (call.deviceId !== deviceId) continue;
      call.settle(
        new DeviceDisconnectedError({
          device: device?.advertisement.name ?? deviceId,
          operation: call.operation,
        }),
      );
    }
  }
}
