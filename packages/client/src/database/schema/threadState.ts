import { haloSchema } from "./schema.js";

// Existing workspace databases retain the original SQL table name.
export const threadState = haloSchema.table({
  table: "halo_session_state",
  fields: {
    id: haloSchema.id(),
    markedDone: haloSchema.boolean("marked_done"),
    readReceiptCursorId: haloSchema.optional(
      haloSchema.text("read_receipt_cursor_id"),
    ),
  },
  relations: {},
});
