import { connectionRequestKey, type ConnectionRequest } from "@get-halo/client";

// Released desktop clients validate the old card schema before sending IPC.
// These routing markers are inert: setup authority stays on the CP.
export function addConnectionCard(
  requests: ConnectionRequest[],
  request: ConnectionRequest,
) {
  const compatible = {
    client: "control-plane",
    clientOwner: "org" as const,
    owner: "user" as const,
    template: "control-plane",
    ...request,
    connectionName: request.connectionName ?? "default",
    // Marks the placeholder name, so starting the card adds a connection.
    newConnection: request.connectionName === undefined,
  };
  if (
    !requests.some(
      (existing) =>
        connectionRequestKey(existing) === connectionRequestKey(compatible),
    )
  )
    requests.push(compatible);
}
