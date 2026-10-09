import { type Static, Type } from "@sinclair/typebox";
import { googleIntegrationDisplay } from "./GoogleIntegrationDisplay.js";

const controlPlaneConnectionRequestSchema = Type.Object({
  kind: Type.Literal("control-plane"),
  integration: Type.String(),
  connectionName: Type.Optional(Type.String()),
  // The account the user asked to connect. It is a hint for the provider's
  // account picker and does not restrict which account is connected.
  account: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
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
  const key = [request.integration, request.connectionName ?? "default"];
  if ("account" in request && request.account !== undefined)
    key.push(request.account);
  return JSON.stringify(key);
}

export function connectionRequestLabel(request: ConnectionRequest) {
  const display = googleIntegrationDisplay(request.integration);
  if (display !== undefined) return display.name;
  return request.integration
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}
