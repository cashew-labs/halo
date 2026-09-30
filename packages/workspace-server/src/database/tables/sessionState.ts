import { haloSchema } from "../schema/schema.js";

export const sessionState = haloSchema.table({
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
