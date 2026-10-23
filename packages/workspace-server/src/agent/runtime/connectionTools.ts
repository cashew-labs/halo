import { ToolResult } from "@executor-js/sdk/core";
import type { RemoteConnectionBackend } from "./ConnectionService.js";

const unavailable = {
  code: "connections_unavailable",
  message: "This workspace has no control-plane connections",
};

// Lists integrations matching the query with the owner's connections, connected first.
export async function listIntegrationsResult(
  backend: RemoteConnectionBackend,
  query: string,
) {
  const [catalog, connections] = await Promise.all([
    backend.catalog(),
    backend.connections(),
  ]);
  if (catalog instanceof Error)
    return ToolResult.fail({
      code: "discovery_failed",
      message: catalog.message,
    });
  if (connections instanceof Error)
    return ToolResult.fail({
      code: "discovery_failed",
      message: connections.message,
    });
  const normalized = query.trim().toLowerCase();
  return ToolResult.ok(
    catalog
      .filter(
        (entry) =>
          entry.integration.toLowerCase().includes(normalized) ||
          entry.name.toLowerCase().includes(normalized),
      )
      .map((entry) => ({
        integration: entry.integration,
        name: entry.name,
        connections: connections
          .filter((connection) => connection.integration === entry.integration)
          .map((connection) => ({
            name: connection.name,
            account: connection.accountLabel,
          })),
      }))
      .toSorted(
        (left, right) =>
          Number(right.connections.length > 0) -
          Number(left.connections.length > 0),
      ),
  );
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
