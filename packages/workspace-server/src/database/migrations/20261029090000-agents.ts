import type { Migration } from "../Migration.js";

export const agentsMigration: Migration = {
  id: "20261029090000-agents",
  sql: `
    CREATE TABLE halo_agents (
      tuple_key BLOB PRIMARY KEY NOT NULL,
      id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      instructions TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ready INTEGER NOT NULL
    );
  `,
};
