import { ToolResult } from "@executor-js/sdk/core";
import type { RemoteConnectionBackend } from "./ConnectionService.js";

const unavailable = {
  code: "connections_unavailable",
  message: "This workspace has no control-plane connections",
};

// Lists integrations with the owner's connections, connected first.
// Like Executor's integration list, every query token must appear in the ID, name or description.
// Lexical matching cannot map "email" to Gmail, so a miss returns every integration for the model to choose from.
export async function listIntegrationsResult(
  backend: RemoteConnectionBackend | undefined,
  query: string,
) {
  if (backend === undefined) return ToolResult.fail(unavailable);
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
  const integrations = catalog
    .map((entry) => ({
      integration: entry.integration,
      name: entry.name,
      description: entry.description,
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
    );
  const tokens = searchTokens(query);
  const matches = integrations.filter((entry) => {
    const text = searchTokens(
      `${entry.integration} ${entry.name} ${entry.description ?? ""}`,
    ).join(" ");
    return tokens.every((token) => text.includes(token));
  });
  return ToolResult.ok({
    integrations: matches.length > 0 ? matches : integrations,
    note:
      matches.length > 0 || integrations.length === 0
        ? undefined
        : `No integration matched "${query.trim()}". These are all available integrations; choose one by meaning, or register a custom integration if none fits.`,
  });
}

// Matches Executor's search normalization: split camelCase and separators, then lowercase.
function searchTokens(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "");
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
