import type { ConnectionRequest } from "@get-halo/shared/ConnectionRequest";
import type { HaloConnectionEvent } from "@get-halo/shared/sessionState";

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

export function connectionStateQueryKey(request: ConnectionRequest) {
  return [
    "executorConnection",
    request.integration,
    request.connectionName,
  ] as const;
}

export function applyConnectionEvent(
  state: ConnectionState | undefined,
  event: HaloConnectionEvent,
): ConnectionState {
  if (state?.status !== "connecting") return state ?? idleConnectionState;
  if (state.connectionId !== event.connectionId) return state;
  if (event.status !== "connected" && state.wasConnected) {
    return { status: "connected" };
  }
  return { status: event.status };
}
