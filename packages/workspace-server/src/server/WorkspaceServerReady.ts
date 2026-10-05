import { Type, type Static } from "@sinclair/typebox";

const connectionSchema = Type.Object({
  host: Type.String(),
  port: Type.Number(),
  token: Type.String(),
});

export const workspaceServerReadySchema = Type.Object({
  workspace: Type.Object({ name: Type.String(), workspaceRoot: Type.String() }),
  connections: Type.Object({
    cli: connectionSchema,
    renderer: connectionSchema,
  }),
});

export type WorkspaceServerReady = Static<typeof workspaceServerReadySchema>;
