import { ToolResult } from "@executor-js/sdk/core";
import type { RemoteConnectionBackend } from "./ConnectionService.js";

const unavailable = {
  code: "connections_unavailable",
  message: "This workspace has no control-plane connections",
};

// Lists the owner's control-plane connections for the agent.
export async function listConnectionsResult(
  backend: RemoteConnectionBackend | undefined,
) {
  const connections = await backend?.connections();
  if (connections === undefined) return ToolResult.fail(unavailable);
  if (connections instanceof Error)
    return ToolResult.fail({
      code: "connections_failed",
      message: connections.message,
    });
  return ToolResult.ok({
    connections: connections.map((connection) => ({
      integration: connection.integration,
      name: connection.name,
      account: connection.accountLabel,
    })),
  });
}

// Removes a control-plane connection after the person approved it.
export async function removeConnectionResult(
  backend: RemoteConnectionBackend | undefined,
  input: { integration: string; name: string },
) {
  const removed = await backend?.removeConnection(input);
  if (removed === undefined) return ToolResult.fail(unavailable);
  if (removed instanceof Error)
    return ToolResult.fail({
      code: "remove_connection_failed",
      message: removed.message,
    });
  return ToolResult.ok(removed);
}
