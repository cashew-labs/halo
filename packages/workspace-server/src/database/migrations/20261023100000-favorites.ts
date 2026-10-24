import type { Migration } from "../Migration.js";

export const favoritesMigration: Migration = {
  id: "20261023100000-favorites",
  sql: `
    CREATE TABLE halo_favorites (
      tuple_key BLOB PRIMARY KEY NOT NULL,
      id TEXT NOT NULL UNIQUE,
      position INTEGER NOT NULL
    );
  `,
};
