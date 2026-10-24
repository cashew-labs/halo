import { implement } from "@orpc/server";
import { contract } from "@get-halo/client";
import { orpcErrors } from "../orpcErrors.js";
import type { FavoritesService } from "./FavoritesService.js";

export type FavoritesRouterContext = { favorites: FavoritesService };
const os = implement(contract.favorites).$context<FavoritesRouterContext>();
export const favoritesRouter = os.router({
  add: os.add.handler(async ({ context, input }) => {
    const updated = await context.favorites.add(input.favoriteIds);
    if (updated instanceof Error) return orpcErrors.badRequest(updated);
  }),
  toggle: os.toggle.handler(async ({ context, input }) => {
    const updated = await context.favorites.toggle(input.favoriteId);
    if (updated instanceof Error) return orpcErrors.badRequest(updated);
  }),
  updateFiles: os.updateFiles.handler(async ({ context, input }) => {
    const updated = await context.favorites.updateFiles(
      input.source,
      input.destination,
    );
    if (updated instanceof Error) return orpcErrors.badRequest(updated);
  }),
});
