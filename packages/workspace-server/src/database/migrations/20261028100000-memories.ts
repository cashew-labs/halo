import type { Migration } from "../Migration.js";

export const memoriesMigration: Migration = {
  id: "20261028100000-memories",
  sql: `
    CREATE TABLE halo_memories (
      tuple_key BLOB PRIMARY KEY NOT NULL,
      id TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      text TEXT NOT NULL,
      thread_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `,
};
