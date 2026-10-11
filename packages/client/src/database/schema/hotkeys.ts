import { haloSchema } from "./schema.js";
import type { Hotkey } from "../../hotkeys.js";

export const hotkeys = haloSchema.table({
  table: "halo_hotkeys",
  fields: {
    id: haloSchema.id(),
    userId: haloSchema.text("user_id"),
    label: haloSchema.text(),
    accelerator: haloSchema.text(),
    action: haloSchema.json<Hotkey["action"]>(),
    position: haloSchema.number(),
  },
  relations: {},
});
