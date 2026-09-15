import { randomUUID } from "node:crypto";
import { OAUTH2_SESSION_TTL_MS } from "@executor-js/sdk/core";
import * as errore from "errore";
import {
  connectionRequestKey,
  type ConnectionRequest,
} from "@get-halo/shared/ConnectionRequest";
import type {
  ConnectionStarted,
  OAuthCompletion,
} from "@get-halo/shared/contract";
import {
  applyConnectionEvent,
  type HaloConnectionEvent,
  type HaloConnectionState,
} from "@get-halo/shared/sessionState";

export class ConnectionSessionMismatchError extends errore.createTaggedError({
  name: "ConnectionSessionMismatchError",
  message: "The connection does not belong to session '$sessionId'.",
}) {}

export class OAuthStateNotFoundError extends errore.createTaggedError({
  name: "OAuthStateNotFoundError",
  message: "The OAuth state is not pending.",
}) {}

type PendingConnection = {
  connectionId: string;
  completion: OAuthCompletion;
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
  completion: OAuthCompletion;
};

type OAuthRuntime = {
  startOAuth(
    input: ConnectionRequest & { redirectUri: string },
  ): Promise<
    | Error
    | { status: "connected" }
    | { status: "redirect"; authorizationUrl: string; state: string }
  >;
  completeOAuth(input: {
    state: string;
    code: string;
  }): Promise<Error | undefined>;
  cancelOAuth(state: string): Promise<Error | undefined>;
};

export type OAuthCompletionTarget = Pick<
  PendingConnection,
  "completion" | "sessionId"
>;

export class ConnectionService {
  private readonly pendingConnections = new Map<string, PendingConnection>();
  private readonly connectionIdsByState = new Map<string, string>();
  private readonly connectionStatesBySession = new Map<
    string,
    HaloConnectionState[]
  >();

  constructor(private readonly runtime: OAuthRuntime) {}

  close() {
    for (const pending of this.pendingConnections.values()) {
      clearTimeout(pending.expires);
    }
    this.pendingConnections.clear();
    this.connectionIdsByState.clear();
    this.connectionStatesBySession.clear();
  }

  statesForSession(sessionId: string) {
    const states = this.connectionStatesBySession.get(sessionId);
    return states === undefined ? [] : states;
  }

  completionTarget(state: string): OAuthCompletionTarget | undefined {
    const connectionId = this.connectionIdsByState.get(state);
    if (connectionId === undefined) return undefined;
    const pending = this.pendingConnections.get(connectionId);
    if (pending === undefined) return undefined;
    return { completion: pending.completion, sessionId: pending.sessionId };
  }

  async startConnection(
    input: StartConnectionInput,
  ): Promise<ConnectionStarted | Error> {
    const started = await this.runtime.startOAuth({
      ...input.request,
      redirectUri: input.completion.redirectUri,
    });
    if (started instanceof Error) return started;

    const connectionId = randomUUID();
    if (started.status === "connected") {
      this.recordEvent(input.sessionId, {
        type: "halo.connection",
        connectionId,
        request: input.request,
        status: "connected",
      });
      return { status: "connected" };
    }

    const previous = this.statesForSession(input.sessionId).find(
      (state) =>
        connectionRequestKey(state.request) ===
        connectionRequestKey(input.request),
    );
    const wasConnected = previous?.status === "connected";
    const expiresAt = Date.now() + OAUTH2_SESSION_TTL_MS;
    const expires = setTimeout(async () => {
      const expired = await this.expireConnection(connectionId);
      if (expired instanceof Error) {
        console.warn("OAuth expiry failed:", expired);
      }
    }, OAUTH2_SESSION_TTL_MS);
    const pending: PendingConnection = {
      connectionId,
      completion: input.completion,
      expires,
      onEvent: input.onEvent,
      request: input.request,
      sessionId: input.sessionId,
      state: started.state,
    };
    this.pendingConnections.set(connectionId, pending);
    this.connectionIdsByState.set(started.state, connectionId);
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
      authorizationUrl: started.authorizationUrl,
      connectionId,
      expiresAt,
      wasConnected,
    };
  }

  async completeOAuth(input: { state: string; code: string }) {
    const pending = this.takeConnectionByState(input.state);
    if (pending === undefined) return new OAuthStateNotFoundError();
    const completed = await this.runtime.completeOAuth(input);
    if (completed instanceof Error) {
      const notified = await this.publishEvent(
        pending,
        this.connectionEvent(pending, "cancelled"),
      );
      if (notified instanceof Error) {
        console.warn("OAuth failure notification failed:", notified);
      }
      return completed;
    }
    return await this.publishEvent(
      pending,
      this.connectionEvent(pending, "connected"),
    );
  }

  async cancelOAuth(state: string) {
    const pending = this.takeConnectionByState(state);
    if (pending === undefined) return new OAuthStateNotFoundError();
    const cancelled = await this.runtime.cancelOAuth(state);
    const notified = await this.publishEvent(
      pending,
      this.connectionEvent(pending, "cancelled"),
    );
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
    const notified = await this.publishEvent(
      pending,
      this.connectionEvent(pending, "cancelled"),
    );
    if (cancelled instanceof Error) return cancelled;
    return notified;
  }

  private async expireConnection(connectionId: string) {
    const pending = this.takeConnection(connectionId);
    if (pending === undefined) return;
    const cancelled = await this.runtime.cancelOAuth(pending.state);
    const notified = await this.publishEvent(
      pending,
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
    status: "connected" | "cancelled" | "expired",
  ): HaloConnectionEvent {
    return {
      type: "halo.connection",
      connectionId: pending.connectionId,
      request: pending.request,
      status,
    };
  }

  private async publishEvent(
    pending: Pick<PendingConnection, "onEvent" | "sessionId">,
    event: HaloConnectionEvent,
  ) {
    this.recordEvent(pending.sessionId, event);
    return await pending.onEvent(event);
  }

  private recordEvent(sessionId: string, event: HaloConnectionEvent) {
    this.connectionStatesBySession.set(
      sessionId,
      applyConnectionEvent(this.statesForSession(sessionId), event),
    );
  }
}
