import { haloSchema } from "./schema.js";
import type { MemoryScope } from "../../memory.js";

// Times are epoch milliseconds. Entries render in createdAt order.
export const memories = haloSchema.table({
  table: "halo_memories",
  fields: {
    id: haloSchema.id(),
    scope: haloSchema.text<MemoryScope>(),
    text: haloSchema.text(),
    // The thread that last wrote the entry.
    threadId: haloSchema.optional(haloSchema.text("thread_id")),
    createdAt: haloSchema.number("created_at"),
    updatedAt: haloSchema.number("updated_at"),
  },
  relations: {},
});
