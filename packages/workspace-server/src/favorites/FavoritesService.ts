import * as errore from "errore";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import type { DatabaseService } from "../database/DatabaseService.js";

class FavoritesError extends errore.createTaggedError({
  name: "FavoritesError",
  message: "Could not update favorites",
}) {}

export class FavoritesService {
  // Commands from every device share the same ordering and VM-owned records.
  private readonly actionQueue = new SerialQueue();
  private readonly db: DatabaseService;

  constructor(ctx: { db: DatabaseService }) {
    this.db = ctx.db;
  }

  // Import browser favorites without removing records added on another device.
  async add(favoriteIds: string[]) {
    if (
      favoriteIds.some(
        (id) => !/^(file:|extension:|automation:|session:).+/.test(id),
      )
    )
      return new FavoritesError();
    return await this.actionQueue.run(async () => {
      await using tx = this.db.useTransaction();
      const favorites = await tx
        .query({ collection: "favorites" })
        .catch((cause) => new FavoritesError({ cause }));
      if (favorites instanceof Error) return favorites;
      const existing = new Set(favorites.map((item) => item.id));
      let position = Math.max(0, ...favorites.map((item) => item.position));
      for (const favoriteId of new Set(favoriteIds)) {
        if (existing.has(favoriteId)) continue;
        tx.set("favorites", { id: favoriteId, position: ++position });
      }
      return await this.db
        .commit(tx)
        .catch((cause) => new FavoritesError({ cause }));
    });
  }

  async toggle(favoriteId: string) {
    if (!/^(file:|extension:|automation:|session:).+/.test(favoriteId))
      return new FavoritesError();
    return await this.actionQueue.run(async () => {
      await using tx = this.db.useTransaction();
      const favorites = await tx
        .query({ collection: "favorites" })
        .catch((cause) => new FavoritesError({ cause }));
      if (favorites instanceof Error) return favorites;
      if (favorites.some((item) => item.id === favoriteId))
        tx.remove("favorites", favoriteId);
      else
        tx.set("favorites", {
          id: favoriteId,
          position: Math.max(0, ...favorites.map((item) => item.position)) + 1,
        });
      return await this.db
        .commit(tx)
        .catch((cause) => new FavoritesError({ cause }));
    });
  }

  async updateFiles(source: string, destination?: string) {
    return await this.actionQueue.run(async () => {
      await using tx = this.db.useTransaction();
      const favorites = await tx
        .query({ collection: "favorites" })
        .catch((cause) => new FavoritesError({ cause }));
      if (favorites instanceof Error) return favorites;
      for (const favorite of favorites) {
        if (!favorite.id.startsWith("file:")) continue;
        const path = favorite.id.slice(5);
        if (path !== source && !path.startsWith(`${source}/`)) continue;
        tx.remove("favorites", favorite.id);
        if (destination !== undefined)
          tx.set("favorites", {
            ...favorite,
            id: `file:${destination}${path.slice(source.length)}`,
          });
      }
      return await this.db
        .commit(tx)
        .catch((cause) => new FavoritesError({ cause }));
    });
  }
}
