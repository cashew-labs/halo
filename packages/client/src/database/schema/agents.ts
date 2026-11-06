import { haloSchema } from "./schema.js";
import type { AgentAvatar } from "../../agents.js";

export const agents = haloSchema.table({
  table: "halo_agents",
  fields: {
    id: haloSchema.id(),
    threadId: haloSchema.text("thread_id"),
    name: haloSchema.text(),
    instructions: haloSchema.text(),
    avatar: haloSchema.optional(haloSchema.json<AgentAvatar>()),
    createdAt: haloSchema.number("created_at"),
    ready: haloSchema.boolean(),
  },
  relations: {},
});
