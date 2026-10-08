import { type Static, Type } from "@sinclair/typebox";
import { googleIntegrationDisplay } from "./GoogleIntegrationDisplay.js";

export const connectionRequestSchema = Type.Object({
  kind: Type.Literal("control-plane"),
  integration: Type.String(),
  connectionName: Type.Optional(Type.String()),
});

export type ConnectionRequest = Static<typeof connectionRequestSchema>;

export function connectionRequestKey(request: ConnectionRequest) {
  return JSON.stringify([
    request.kind,
    request.integration,
    request.connectionName,
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
