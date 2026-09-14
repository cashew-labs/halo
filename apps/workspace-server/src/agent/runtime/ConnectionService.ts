import { randomUUID } from "node:crypto";
import { OAUTH2_SESSION_TTL_MS } from "@executor-js/sdk/core";
import * as errore from "errore";
import type { ConnectionRequest } from "@get-halo/shared/ConnectionRequest";
import type { ConnectionStarted } from "@get-halo/shared/contract";
import type { HaloConnectionEvent } from "@get-halo/shared/sessionState";
import type { ToolRuntime } from "./ToolRuntime.js";

export class ConnectionSessionMismatchError extends errore.createTaggedError({
  name: "ConnectionSessionMismatchError",
  message: "The connection does not belong to session '$sessionId'.",
}) {}

type PendingConnection = {
  connectionId: string;
  expires: ReturnType<typeof setTimeout>;
  onEvent: (event: HaloConnectionEvent) => Promise<Error | undefined>;
  request: ConnectionRequest;
  sessionId: string;
  state: string;
};

type StartConnectionInput = {
  onEvent: PendingConnection["onEvent"];
  request: ConnectionRequest;
  sessionId: string;
};

export class ConnectionService {
  private readonly pendingConnections = new Map<string, PendingConnection>();
  private readonly connectionIdsByState = new Map<string, string>();

  constructor(private readonly runtime: ToolRuntime) {}

  close() {
    for (const pending of this.pendingConnections.values()) {
      clearTimeout(pending.expires);
    }
    this.pendingConnections.clear();
    this.connectionIdsByState.clear();
  }

  async startConnection(
    input: StartConnectionInput,
  ): Promise<ConnectionStarted | Error> {
    const started = await this.runtime.startOAuth(input.request);
    if (started instanceof Error) return started;
    if (started.status === "connected") return { status: "connected" };

    const connectionId = randomUUID();
    const expires = setTimeout(async () => {
      const expired = await this.expireConnection(connectionId);
      if (expired instanceof Error) {
        console.warn("OAuth expiry failed:", expired);
      }
    }, OAUTH2_SESSION_TTL_MS);
    const pending: PendingConnection = {
      connectionId,
      expires,
      onEvent: input.onEvent,
      request: input.request,
      sessionId: input.sessionId,
      state: started.state,
    };
    this.pendingConnections.set(connectionId, pending);
    this.connectionIdsByState.set(started.state, connectionId);
    return {
      status: "authorization-required",
      authorizationUrl: started.authorizationUrl,
      connectionId,
      expiresInMs: OAUTH2_SESSION_TTL_MS,
    };
  }

  async completeOAuth(input: { state: string; code: string }) {
    const pending = this.takeConnectionByState(input.state);
    const completed = await this.runtime.completeOAuth(input);
    if (completed instanceof Error) {
      if (pending !== undefined) {
        const notified = await pending.onEvent(
          this.connectionEvent(pending, "cancelled"),
        );
        if (notified instanceof Error) {
          console.warn("OAuth failure notification failed:", notified);
        }
      }
      return completed;
    }
    if (pending === undefined) return;
    return await pending.onEvent(this.connectionEvent(pending, "connected"));
  }

  async cancelOAuth(state: string) {
    const pending = this.takeConnectionByState(state);
    const cancelled = await this.runtime.cancelOAuth(state);
    const notified =
      pending === undefined
        ? undefined
        : await pending.onEvent(this.connectionEvent(pending, "cancelled"));
    if (cancelled instanceof Error) return cancelled;
    return notified;
  }

  async cancelConnection(input: { connectionId: string; sessionId: string }) {
    const pending = this.pendingConnections.get(input.connectionId);
    if (pending === undefined) return;
    if (pending.sessionId !== input.sessionId) {
      return new ConnectionSessionMismatchError({ sessionId: input.sessionId });
    }
    this.takeConnection(input.connectionId);
    const cancelled = await this.runtime.cancelOAuth(pending.state);
    const notified = await pending.onEvent(
      this.connectionEvent(pending, "cancelled"),
    );
    if (cancelled instanceof Error) return cancelled;
    return notified;
  }

  private async expireConnection(connectionId: string) {
    const pending = this.takeConnection(connectionId);
    if (pending === undefined) return;
    const cancelled = await this.runtime.cancelOAuth(pending.state);
    const notified = await pending.onEvent(
      this.connectionEvent(pending, "expired"),
    );
    if (cancelled instanceof Error) return cancelled;
    return notified;
  }

  private takeConnectionByState(state: string) {
    const connectionId = this.connectionIdsByState.get(state);
    if (connectionId === undefined) return undefined;
    return this.takeConnection(connectionId);
  }

  private takeConnection(connectionId: string) {
    const pending = this.pendingConnections.get(connectionId);
    if (pending === undefined) return;
    clearTimeout(pending.expires);
    this.pendingConnections.delete(connectionId);
    this.connectionIdsByState.delete(pending.state);
    return pending;
  }

  private connectionEvent(
    pending: PendingConnection,
    status: HaloConnectionEvent["status"],
  ): HaloConnectionEvent {
    return {
      type: "halo.connection",
      connectionId: pending.connectionId,
      request: pending.request,
      status,
    };
  }
}
