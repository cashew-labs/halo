import type { Migration } from "../Migration.js";

export const tandemHotkeysMigration: Migration = {
  id: "20261006110000-tandem-hotkeys",
  sql: `CREATE TABLE halo_hotkeys (
    tuple_key BLOB PRIMARY KEY NOT NULL,
    id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    label TEXT NOT NULL,
    accelerator TEXT NOT NULL,
    action TEXT NOT NULL,
    position INTEGER NOT NULL
  );`,
};
