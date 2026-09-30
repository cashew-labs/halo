import type { Hotkey } from "@get-halo/client";
import { defineTable } from "./defineTable.js";
import * as field from "./fields.js";

export const hotkeys = defineTable({
  table: "halo_hotkeys",
  fields: {
    id: field.id(),
    userId: field.text("user_id"),
    label: field.text(),
    accelerator: field.text(),
    action: field.json<Hotkey["action"]>(),
    position: field.number(),
  },
  relations: {},
});
