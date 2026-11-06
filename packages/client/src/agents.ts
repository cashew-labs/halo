import { Type, type Static } from "@sinclair/typebox";

// An open-bot-avatar definition and its body color. The server checks the geometry.
const agentAvatarSchema = Type.Object({
  definition: Type.Object({
    version: Type.Literal(1),
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    body: Type.Object({ path: Type.String({ minLength: 1 }) }),
    eyes: Type.Object({
      x: Type.Number(),
      y: Type.Number(),
      spacing: Type.Number(),
      scale: Type.Number(),
    }),
  }),
  color: Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
});

export const newAgentSchema = Type.Object({
  requestId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  instructions: Type.String(),
  avatar: Type.Optional(agentAvatarSchema),
});

export const agentSettingsSchema = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  // Omit either to keep its current value.
  instructions: Type.Optional(Type.String()),
  avatar: Type.Optional(agentAvatarSchema),
});

export type AgentAvatar = Static<typeof agentAvatarSchema>;
export type NewAgentInput = Static<typeof newAgentSchema>;
export type AgentSettingsInput = Static<typeof agentSettingsSchema>;
export type AgentRecord = {
  id: string;
  threadId: string;
  name: string;
  instructions: string;
  avatar?: AgentAvatar;
  createdAt: number;
};
