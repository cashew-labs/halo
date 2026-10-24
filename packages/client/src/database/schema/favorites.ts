import { haloSchema } from "./schema.js";

export const favorites = haloSchema.table({
  table: "halo_favorites",
  fields: {
    id: haloSchema.id(),
    position: haloSchema.number(),
  },
  relations: {},
});
