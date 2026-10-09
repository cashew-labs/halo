import {
  connectionRequestKey,
  type ConnectionRequest,
  type HaloConnectionEvent,
  type HaloConnectionState,
} from "@get-halo/client";

export type ConnectionState =
  | { status: "idle" | "connected" | "cancelled" | "expired" | "failed" }
  | { status: "starting"; wasConnected: boolean }
  | {
      status: "connecting";
      connectionId: string;
      expiresAt: number;
      wasConnected: boolean;
    };

export const idleConnectionState: ConnectionState = { status: "idle" };

export function connectionStateQueryKey(
  sessionId: string | undefined,
  request: ConnectionRequest,
) {
  return [
    "executorConnection",
    sessionId,
    connectionRequestKey(request),
  ] as const;
}

export function connectionStateFromServer(
  state: HaloConnectionState,
): ConnectionState {
  if (state.status === "connecting") {
    return {
      status: state.status,
      connectionId: state.connectionId,
      expiresAt: state.expiresAt,
      wasConnected: state.wasConnected,
    };
  }
  return { status: state.status };
}

export function applyConnectionEvent(
  state: ConnectionState | undefined,
  event: HaloConnectionEvent,
): ConnectionState {
  if (event.status === "connecting") return connectionStateFromServer(event);
  if (state?.status !== "connecting") {
    return state === undefined ? idleConnectionState : state;
  }
  if (state.connectionId !== event.connectionId) return state;
  if (event.status !== "connected" && state.wasConnected) {
    return { status: "connected" };
  }
  return { status: event.status };
}

export type StartedConnectionCard = { cardId?: string };

// Names the card that started the latest attempt for a request. Server
// snapshots replace connection state but never this client-only entry.
export function connectionCardQueryKey(
  sessionId: string | undefined,
  request: ConnectionRequest,
) {
  return [
    "executorConnectionCard",
    sessionId,
    connectionRequestKey(request),
  ] as const;
}

// Every card for a request shares one attempt while it is in progress. A
// finished attempt stays on the card that started it; other cards offer a
// fresh connection. Without a known starting card, every card shows the result.
export function connectionStateForCard(
  state: ConnectionState,
  startedCardId: string | undefined,
  cardId: string,
): ConnectionState {
  if (
    state.status === "idle" ||
    state.status === "starting" ||
    state.status === "connecting"
  )
    return state;
  if (startedCardId === undefined || startedCardId === cardId) return state;
  return idleConnectionState;
}

// A failed start keeps an existing connection visible.
export function connectionStateAfterFailedStart(
  state: ConnectionState | undefined,
): ConnectionState {
  if (
    (state?.status === "starting" || state?.status === "connecting") &&
    state.wasConnected
  )
    return { status: "connected" };
  return idleConnectionState;
}

// Cancelling a reconnect keeps the existing connection.
export function connectionStateAfterCancel(
  state: ConnectionState | undefined,
): ConnectionState | undefined {
  if (state?.status !== "connecting") return state;
  return state.wasConnected ? { status: "connected" } : { status: "cancelled" };
}
