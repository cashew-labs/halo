import { type Static, Type } from "@sinclair/typebox";

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

export function connectionRequestLabel(request: ConnectionRequest) {
  return request.integration
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}
