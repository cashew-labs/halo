import { haloSchema } from "./schema.js";

export const agents = haloSchema.table({
  table: "halo_agents",
  fields: {
    id: haloSchema.id(),
    threadId: haloSchema.text("thread_id"),
    name: haloSchema.text(),
    instructions: haloSchema.text(),
    createdAt: haloSchema.number("created_at"),
    ready: haloSchema.boolean(),
  },
  relations: {},
});
