import type { Migration } from "../Migration.js";

export const tandemSessionStateMigration: Migration = {
  id: "20261006130000-tandem-session-state",
  sql: `CREATE TABLE halo_session_state (
    tuple_key BLOB PRIMARY KEY NOT NULL,
    id TEXT NOT NULL UNIQUE,
    marked_done INTEGER NOT NULL,
    read_receipt_cursor_id TEXT
  );`,
};
