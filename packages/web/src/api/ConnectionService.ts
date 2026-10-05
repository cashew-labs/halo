import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Stream } from "@get-halo/shared/Stream";
import { ORPCError } from "@orpc/client";
import {
  AuthenticationRequiredError,
  checkServerCompatibility,
  haloProtocolVersion,
  IncompatibleServerError,
  type HaloClient,
  type WorkspaceInfo,
} from "@get-halo/client";
import * as errore from "errore";
import type { HostApi } from "../HostApi.js";
import type { ControlPlaneWorkspaceStatus } from "@get-halo/shared/controlPlaneContract";

type ConnectionState = {
  status:
    | "connecting"
    | "reconnecting"
    | "offline"
    | "synchronizing"
    | "connected"
    | "incompatible"
    | "authentication";
  api?: HaloClient;
  workspace?: WorkspaceInfo;
  error?: Error;
  power?: ControlPlaneWorkspaceStatus["status"];
};

const frameActivitySchema = Type.Object(
  { type: Type.Literal("halo:user-activity") },
  { additionalProperties: false },
);

class ConnectionAttemptError extends errore.createTaggedError({
  name: "ConnectionAttemptError",
  message: "Could not restore the workspace connection.",
}) {}
class ConnectionTimeoutError extends errore.createTaggedError({
  name: "ConnectionTimeoutError",
  message: "The server did not respond within ten seconds.",
  extends: errore.AbortError,
}) {}
export class ConnectionInterruptedError extends errore.createTaggedError({
  name: "ConnectionInterruptedError",
  message: "Connection lost. Automatically reconnecting…",
  extends: errore.AbortError,
}) {}

export class ConnectionService {
  // The last usable client/data keep React panes mounted through outages.
  private state: ConnectionState = { status: "connecting" };
  readonly changes = new Stream<ConnectionState>();
  private active = false;
  private generation = 0;
  private attempting = false;
  private failures = 0;
  private attempts = 0;
  private outageSince: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private probe: AbortController | undefined;
  private lastActivitySent = 0;
  private reportingActivity = false;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private checkingStatus = false;
  private readonly host: HostApi;

  constructor(ctx: { host: HostApi }) {
    this.host = ctx.host;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => this.changes.subscribe(listener);

  start() {
    this.active = true;
    window.addEventListener("online", this.retry);
    window.addEventListener("offline", this.offline);
    document.addEventListener("visibilitychange", this.foreground);
    window.addEventListener("focus", this.returned);
    window.addEventListener("message", this.frameActivity);
    for (const event of ["pointermove", "pointerdown", "keydown", "wheel"])
      document.addEventListener(event, this.userActivity, { passive: true });
    this.returned();
    void this.checkStatus().catch(console.error);
  }

  dispose() {
    this.active = false;
    this.generation++;
    this.attempting = false;
    clearTimeout(this.timer);
    clearTimeout(this.statusTimer);
    this.controller?.abort(new ConnectionInterruptedError());
    this.probe?.abort(new ConnectionInterruptedError());
    window.removeEventListener("online", this.retry);
    window.removeEventListener("offline", this.offline);
    document.removeEventListener("visibilitychange", this.foreground);
    window.removeEventListener("focus", this.returned);
    window.removeEventListener("message", this.frameActivity);
    for (const event of ["pointermove", "pointerdown", "keydown", "wheel"])
      document.removeEventListener(event, this.userActivity);
  }

  retry = () => {
    if (
      !this.active ||
      this.attempting ||
      this.reportingActivity ||
      this.state.power === "asleep" ||
      this.state.power === "sleeping" ||
      document.visibilityState !== "visible"
    )
      return;
    if (this.state.status === "connected") {
      void this.check().catch(console.error);
      return;
    }
    if (!navigator.onLine) {
      this.offline();
      return;
    }
    clearTimeout(this.timer);
    void this.connect().catch(console.error);
  };

  private offline = () => {
    clearTimeout(this.timer);
    this.generation++;
    this.attempting = false;
    this.controller?.abort(new ConnectionInterruptedError());
    this.probe?.abort(new ConnectionInterruptedError());
    this.publish({
      ...this.state,
      status: "offline",
      power: undefined,
      error: undefined,
    });
  };

  private foreground = () => {
    if (document.visibilityState !== "visible") return;
    this.returned();
    if (this.state.status === "connected") {
      void this.check().catch(console.error);
      return;
    }
    this.retry();
  };

  fail(api: HaloClient, error: Error) {
    if (api !== this.state.api || !this.active || this.attempting) return;
    if (errore.isAbortError(error)) return;
    const rpcError = errore.findCause(error, ORPCError);
    if (
      rpcError !== undefined &&
      ![
        "MALFORMED_ORPC_RESPONSE",
        "UNAUTHORIZED",
        "UNSUPPORTED_PROTOCOL",
      ].includes(rpcError.code)
    )
      return;
    this.probe?.abort(new ConnectionInterruptedError({ cause: error }));
    this.generation++;
    this.failed(error);
  }

  ready(api: HaloClient) {
    if (api !== this.state.api || this.state.status !== "synchronizing") return;
    clearTimeout(this.timer);
    this.failures = 0;
    this.publish({ ...this.state, status: "connected", error: undefined });
    this.timer = setTimeout(
      () => void this.check().catch(console.error),
      30_000,
    );
  }

  private async connect() {
    this.attempts++;
    this.attempting = true;
    this.controller?.abort(new ConnectionInterruptedError());
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    this.publish({
      ...this.state,
      status: this.state.api === undefined ? "connecting" : "reconnecting",
      error: undefined,
    });
    const timeout = setTimeout(
      () => controller.abort(new ConnectionTimeoutError()),
      10_000,
    );
    let stopWaiting: (() => void) | undefined;
    const canceled = new Promise<Error>((resolve) => {
      const onAbort = () => resolve(new ConnectionTimeoutError());
      controller.signal.addEventListener("abort", onAbort, { once: true });
      stopWaiting = () =>
        controller.signal.removeEventListener("abort", onAbort);
    });
    const connected = await Promise.race([
      this.host
        .connectHalo({
          signal: controller.signal,
          canRequest: (path) =>
            generation === this.generation &&
            (this.state.status === "connected" ||
              [
                "server.info",
                "server.watch",
                "workspace.get",
                "thread.events",
              ].includes(path.join("."))),
          onDisconnect: (error) => {
            if (generation === this.generation && this.state.api !== undefined)
              this.fail(this.state.api, error);
          },
        })
        .catch((cause) => new ConnectionAttemptError({ cause })),
      canceled,
    ]);
    stopWaiting?.();
    const workspace =
      connected === undefined ||
      connected instanceof Error ||
      controller.signal.aborted
        ? undefined
        : await connected.workspace
            .get(undefined, { signal: controller.signal })
            .catch((cause) => new ConnectionAttemptError({ cause }));
    clearTimeout(timeout);
    if (!this.active || generation !== this.generation) return;
    this.attempting = false;
    if (controller.signal.aborted) {
      this.failed(new ConnectionTimeoutError());
      return;
    }
    if (connected instanceof Error) {
      this.failed(connected);
      return;
    }
    if (workspace instanceof Error) {
      this.failed(workspace);
      return;
    }
    if (connected === undefined || workspace === undefined) {
      this.failed();
      return;
    }
    this.publish({
      ...this.state,
      status: "synchronizing",
      api: connected,
      workspace,
    });
    this.timer = setTimeout(
      () => this.failed(new ConnectionTimeoutError()),
      10_000,
    );
  }

  private failed(error?: Error) {
    this.controller?.abort(new ConnectionInterruptedError({ cause: error }));
    const incompatible =
      error === undefined
        ? undefined
        : errore.findCause(error, IncompatibleServerError);
    const rpcError =
      error === undefined ? undefined : errore.findCause(error, ORPCError);
    const authentication =
      error === undefined
        ? undefined
        : (errore.findCause(error, AuthenticationRequiredError) ??
          (rpcError?.code === "UNAUTHORIZED"
            ? new AuthenticationRequiredError({ cause: error })
            : undefined));
    const status =
      incompatible !== undefined
        ? "incompatible"
        : authentication !== undefined
          ? "authentication"
          : navigator.onLine
            ? "reconnecting"
            : "offline";
    this.publish({
      ...this.state,
      status,
      power:
        status === "authentication" || status === "offline"
          ? undefined
          : this.state.power,
      error: incompatible ?? authentication ?? error,
    });
    clearTimeout(this.timer);
    if (!this.active || status === "offline" || status === "authentication")
      return;
    const delay =
      status === "incompatible"
        ? 30_000
        : Math.min(15_000, 1_000 * 2 ** Math.min(this.failures++, 4));
    this.timer = setTimeout(
      this.retry,
      Math.min(15_000, delay * (0.8 + Math.random() * 0.4)) +
        (status === "incompatible" ? 15_000 : 0),
    );
  }

  private async check() {
    if (
      !this.active ||
      this.state.status !== "connected" ||
      this.state.power === "asleep" ||
      this.state.power === "sleeping" ||
      this.probe !== undefined
    )
      return;
    if (document.visibilityState !== "visible") {
      this.timer = setTimeout(
        () => void this.check().catch(console.error),
        30_000,
      );
      return;
    }
    const api = this.state.api;
    if (api === undefined) return;
    const generation = this.generation;
    const probe = new AbortController();
    this.probe = probe;
    const timeout = setTimeout(
      () => probe.abort(new ConnectionTimeoutError()),
      10_000,
    );
    const info = await api.server
      .info(undefined, { signal: probe.signal })
      .catch((cause) => new ConnectionAttemptError({ cause }));
    clearTimeout(timeout);
    if (this.probe === probe) this.probe = undefined;
    if (!this.active || generation !== this.generation) return;
    const error =
      info instanceof Error
        ? info
        : checkServerCompatibility({
            info,
            service: "workspace",
            clientProtocolVersion: haloProtocolVersion,
          });
    if (error instanceof Error) {
      this.failed(error);
      return;
    }
    this.timer = setTimeout(
      () => void this.check().catch(console.error),
      30_000,
    );
  }

  private returned = () => this.reportActivity({ force: true });

  private async checkStatus() {
    if (
      !this.active ||
      this.checkingStatus ||
      this.host.getWorkspaceStatus === undefined
    )
      return;
    this.checkingStatus = true;
    const activityAt = this.lastActivitySent;
    const result = await this.host.getWorkspaceStatus();
    this.checkingStatus = false;
    if (!this.active) return;
    if (result instanceof Error) console.warn(result);
    // Ignore a lookup that started before a newer wake request.
    if (
      !(result instanceof Error) &&
      result !== undefined &&
      !this.reportingActivity &&
      activityAt === this.lastActivitySent
    ) {
      const previous = this.state.power;
      if (result.status === "asleep" && previous !== "asleep") {
        clearTimeout(this.timer);
        this.generation++;
        this.attempting = false;
        this.controller?.abort(new ConnectionInterruptedError());
        this.probe?.abort(new ConnectionInterruptedError());
        this.publish({
          ...this.state,
          status: ["authentication", "incompatible", "offline"].includes(
            this.state.status,
          )
            ? this.state.status
            : "reconnecting",
          power: "asleep",
          error:
            this.state.status === "authentication" ||
            this.state.status === "incompatible"
              ? this.state.error
              : undefined,
        });
      } else if (result.status !== previous) {
        this.publish({ ...this.state, power: result.status });
        if (result.status === "running") this.retry();
      }
    }
    this.statusTimer = setTimeout(
      () => void this.checkStatus().catch(console.error),
      document.visibilityState === "visible" && !(result instanceof Error)
        ? 2_000
        : 30_000,
    );
  }

  private frameActivity = (event: MessageEvent<unknown>) => {
    if (!Value.Check(frameActivitySchema, event.data)) return;
    if (
      [...document.querySelectorAll("iframe")].some(
        (frame) => frame.contentWindow === event.source,
      )
    )
      this.userActivity();
  };

  private userActivity = () => this.reportActivity();

  private reportActivity(ctx?: { force: true }) {
    if (
      !this.active ||
      document.visibilityState !== "visible" ||
      this.reportingActivity ||
      (ctx?.force !== true &&
        this.state.power !== "asleep" &&
        Date.now() - this.lastActivitySent < 10_000)
    )
      return;
    this.lastActivitySent = Date.now();
    this.reportingActivity = true;
    if (this.state.power === "asleep" || this.state.power === "sleeping")
      this.publish({
        ...this.state,
        power: "waking",
        status: "reconnecting",
        error: undefined,
      });
    // oxlint-disable-next-line typescript/no-floating-promises -- The host reports errors; retries resume after the activity request finishes.
    this.recordActivity().then(() => {
      this.reportingActivity = false;
      this.retry();
    });
  }

  private async recordActivity() {
    const result = await this.host.recordWorkspaceActivity?.();
    if (result instanceof Error) {
      console.warn(result);
      if (this.active && this.state.power === "waking") {
        this.publish({ ...this.state, power: undefined });
        this.failed(result);
      }
      return;
    }
    if (!this.active) return;
    if (this.state.power === "waking")
      this.publish({ ...this.state, power: "running" });
    this.failures = 0;
    if (this.state.status !== "connected") {
      this.generation++;
      this.attempting = false;
      this.controller?.abort(new ConnectionInterruptedError());
    }
  }

  diagnostics() {
    return {
      status: this.state.status,
      power: this.state.power,
      attempts: this.attempts,
      outageSince: this.outageSince,
      workspaceProtocol: haloProtocolVersion,
      reason: this.state.error?.message,
    };
  }

  private publish(state: ConnectionState) {
    if (state.status === "connected") {
      this.outageSince = undefined;
      this.attempts = 0;
    } else this.outageSince ??= new Date().toISOString();
    if (state.status !== this.state.status)
      console.info("Halo connection:", {
        status: state.status,
        at: new Date().toISOString(),
        attempts: this.attempts,
        outageSince: this.outageSince,
        error: state.error?.message,
      });
    this.state = state;
    this.changes.append(state);
  }
}
