import {
  connectionRequestKey,
  type ConnectionRequest,
  type HaloConnectionEvent,
  type HaloConnectionState,
} from "@get-halo/client";

export type ConnectionState =
  | { status: "idle" | "connected" | "cancelled" | "expired" }
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
