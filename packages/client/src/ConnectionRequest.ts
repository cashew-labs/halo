import { type Static, Type } from "@sinclair/typebox";
import { googleIntegrationDisplay } from "./GoogleIntegrationDisplay.js";

export const connectionRequestSchema = Type.Object({
  client: Type.String(),
  clientOwner: Type.Union([Type.Literal("org"), Type.Literal("user")]),
  owner: Type.Union([Type.Literal("org"), Type.Literal("user")]),
  connectionName: Type.String(),
  integration: Type.String(),
  template: Type.String(),
  identityLabel: Type.Optional(Type.String()),
  newConnection: Type.Optional(Type.Boolean()),
});

export type ConnectionRequest = Static<typeof connectionRequestSchema>;

export function connectionRequestKey(request: ConnectionRequest) {
  return JSON.stringify([
    request.client,
    request.clientOwner,
    request.owner,
    request.connectionName,
    request.integration,
    request.template,
    request.identityLabel,
    request.newConnection,
  ]);
}

export function connectionRequestLabel(request: ConnectionRequest) {
  const display = googleIntegrationDisplay(request.integration);
  if (display !== undefined) return display.name;
  return request.integration
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}
