import { Type, type Static } from "@sinclair/typebox";

export const newAgentSchema = Type.Object({
  requestId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  instructions: Type.String(),
});

export const agentSettingsSchema = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  instructions: Type.String(),
});

export type NewAgentInput = Static<typeof newAgentSchema>;
export type AgentSettingsInput = Static<typeof agentSettingsSchema>;
export type AgentRecord = {
  id: string;
  threadId: string;
  name: string;
  instructions: string;
  createdAt: number;
};
