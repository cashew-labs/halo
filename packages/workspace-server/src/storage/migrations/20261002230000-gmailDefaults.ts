import type { Migration } from "../Migration.js";

export const gmailDefaultsMigration: Migration = {
  id: "20261002230000-gmail-defaults",
  sql: `CREATE TABLE halo_gmail_defaults (
    user_id TEXT PRIMARY KEY,
    connection_name TEXT NOT NULL
  );`,
};
