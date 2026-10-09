import { randomUUID } from "node:crypto";
import * as errore from "errore";
import {
  connectionRequestKey,
  type ConnectionRequest,
  type ConnectionStarted,
  applyConnectionEvent,
  type HaloConnectionEvent,
  type HaloConnectionState,
} from "@get-halo/client";

const setupTtlMs = 15 * 60 * 1_000;

export class ConnectionSessionMismatchError extends errore.createTaggedError({
  name: "ConnectionSessionMismatchError",
  message: "The connection does not belong to session '$sessionId'.",
}) {}

export class ConnectionUnavailableError extends errore.createTaggedError({
  name: "ConnectionUnavailableError",
  message: "Control-plane connection setup is unavailable.",
}) {}

type StartConnectionInput = {
  onEvent: (event: HaloConnectionEvent) => Promise<Error | undefined>;
  request: ConnectionRequest;
  sessionId: string;
  legacyClient?: boolean;
};

type PendingConnection = StartConnectionInput & {
  connectionId: string;
  setupId: string;
  expiresAt: number;
  expires: ReturnType<typeof setTimeout>;
};

export type RemoteConnectionBackend = {
  catalog(): Promise<Error | { integration: string; name: string }[]>;
  startSetup(input: {
    integration: string;
    connectionName?: string;
  }): Promise<Error | { setupId: string; setupUrl: string }>;
  setup(input: { setupId: string }): Promise<
    | Error
    | {
        status:
          | "awaiting_credentials"
          | "authorizing"
          | "confirming"
          | "ready"
          | "cancelled"
          | "expired"
          | "failed";
      }
  >;
  cancelSetup(input: { setupId: string }): Promise<Error | undefined>;
};

export class ConnectionService {
  private closed = false;
  private readonly pendingConnections = new Map<string, PendingConnection>();
  private readonly connectionStatesBySession = new Map<
    string,
    HaloConnectionState[]
  >();
  private readonly remote: RemoteConnectionBackend | undefined;

  constructor(ctx: { remote?: RemoteConnectionBackend }) {
    this.remote = ctx.remote;
  }

  close() {
    this.closed = true;
    for (const pending of this.pendingConnections.values())
      clearTimeout(pending.expires);
    this.pendingConnections.clear();
    this.connectionStatesBySession.clear();
  }

  statesForSession(sessionId: string) {
    return this.connectionStatesBySession.get(sessionId) ?? [];
  }

  async startConnection(
    input: StartConnectionInput,
  ): Promise<ConnectionStarted | Error> {
    if (this.remote === undefined || this.closed)
      return new ConnectionUnavailableError();
    const started = await this.remote.startSetup({
      integration: input.request.integration,
      connectionName: input.request.connectionName,
    });
    if (started instanceof Error) return started;
    if (this.closed) {
      const cancelled = await this.remote.cancelSetup({
        setupId: started.setupId,
      });
      if (cancelled instanceof Error) return cancelled;
      return new ConnectionUnavailableError();
    }
    const connectionId = randomUUID();
    const expiresAt = Date.now() + setupTtlMs;
    const pending: PendingConnection = {
      ...input,
      connectionId,
      setupId: started.setupId,
      expiresAt,
      expires: setTimeout(() => void this.pollRemote(connectionId), 1_000),
    };
    this.pendingConnections.set(connectionId, pending);
    const wasConnected = this.statesForSession(input.sessionId).some(
      (state) =>
        connectionRequestKey(state.request) ===
          connectionRequestKey(input.request) && state.status === "connected",
    );
    const notified = await this.publishEvent(pending, {
      type: "halo.connection",
      connectionId,
      request: input.request,
      status: "connecting",
      expiresAt,
      wasConnected,
    });
    if (notified instanceof Error) return notified;
    return {
      status: "authorization-required",
      authorizationUrl: started.setupUrl,
      connectionId,
      expiresAt,
      wasConnected,
    };
  }

  async cancelConnection(input: { connectionId: string; sessionId: string }) {
    const pending = this.pendingConnections.get(input.connectionId);
    if (pending === undefined) return;
    if (pending.sessionId !== input.sessionId)
      return new ConnectionSessionMismatchError({ sessionId: input.sessionId });
    if (this.remote === undefined) return new ConnectionUnavailableError();
    const cancelled = await this.remote.cancelSetup({
      setupId: pending.setupId,
    });
    if (cancelled instanceof Error) return cancelled;
    if (this.pendingConnections.get(input.connectionId) !== pending) return;
    clearTimeout(pending.expires);
    await this.pollRemote(input.connectionId);
  }

  private async pollRemote(connectionId: string) {
    const pending = this.pendingConnections.get(connectionId);
    if (pending === undefined || this.remote === undefined) return;
    const setup = await this.remote.setup({ setupId: pending.setupId });
    if (this.pendingConnections.get(connectionId) !== pending) return;
    if (
      Date.now() >= pending.expiresAt &&
      (setup instanceof Error ||
        (setup.status !== "ready" && setup.status !== "confirming"))
    ) {
      this.takeConnection(connectionId);
      const notified = await this.publishEvent(
        pending,
        this.connectionEvent(pending, "expired"),
      );
      if (notified instanceof Error)
        console.warn("Connection expiry notification failed:", notified);
      return;
    }
    if (setup instanceof Error)
      console.warn("Connection setup lookup failed:", setup);
    if (
      setup instanceof Error ||
      setup.status === "awaiting_credentials" ||
      setup.status === "authorizing" ||
      setup.status === "confirming"
    ) {
      pending.expires = setTimeout(
        () => void this.pollRemote(connectionId),
        2_000,
      );
      return;
    }
    this.takeConnection(connectionId);
    const notified = await this.publishEvent(
      pending,
      this.connectionEvent(
        pending,
        setup.status === "ready" ? "connected" : setup.status,
      ),
    );
    if (notified instanceof Error)
      console.warn("Connection setup notification failed:", notified);
  }

  private takeConnection(connectionId: string) {
    const pending = this.pendingConnections.get(connectionId);
    if (pending === undefined) return;
    clearTimeout(pending.expires);
    this.pendingConnections.delete(connectionId);
    return pending;
  }

  private connectionEvent(
    pending: PendingConnection,
    status: "connected" | "cancelled" | "expired" | "failed",
  ): HaloConnectionEvent {
    return {
      type: "halo.connection",
      connectionId: pending.connectionId,
      request: pending.request,
      status:
        status === "failed" && pending.legacyClient ? "cancelled" : status,
    };
  }

  private async publishEvent(
    pending: StartConnectionInput,
    event: HaloConnectionEvent,
  ) {
    this.connectionStatesBySession.set(
      pending.sessionId,
      applyConnectionEvent(this.statesForSession(pending.sessionId), event),
    );
    return await pending.onEvent(event);
  }
}
