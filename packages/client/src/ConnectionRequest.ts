import { type Static, Type } from "@sinclair/typebox";
import { googleIntegrationDisplay } from "./GoogleIntegrationDisplay.js";

const controlPlaneConnectionRequestSchema = Type.Object({
  kind: Type.Literal("control-plane"),
  integration: Type.String(),
  connectionName: Type.Optional(Type.String()),
});

// Protocol 24 cards and saved transcripts use the workspace-owned OAuth shape.
// Only integration/name are used to start a control-plane setup; these fields
// do not grant client/owner authority over credentials.
const legacyConnectionRequestSchema = Type.Object({
  client: Type.String(),
  clientOwner: Type.Union([Type.Literal("org"), Type.Literal("user")]),
  owner: Type.Union([Type.Literal("org"), Type.Literal("user")]),
  connectionName: Type.String(),
  integration: Type.String(),
  template: Type.String(),
  identityLabel: Type.Optional(Type.String()),
  newConnection: Type.Optional(Type.Boolean()),
});
export const connectionRequestSchema = Type.Union([
  controlPlaneConnectionRequestSchema,
  legacyConnectionRequestSchema,
]);
export type ConnectionRequest = Static<typeof connectionRequestSchema>;

export function connectionRequestKey(request: ConnectionRequest) {
  return JSON.stringify([
    request.integration,
    request.connectionName ?? "default",
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
