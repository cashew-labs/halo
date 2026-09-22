import type { Migration } from "../Migration.js";

export const sessionStatusMigration: Migration = {
  id: "20260921194000-session-status",
  sql: `
    ALTER TABLE halo_sessions
      ADD COLUMN marked_done INTEGER NOT NULL DEFAULT 0
      CHECK (marked_done IN (0, 1));
    ALTER TABLE halo_sessions
      ADD COLUMN read_result_id TEXT;
  `,
};
