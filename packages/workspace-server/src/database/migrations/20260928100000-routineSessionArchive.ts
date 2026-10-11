import type { Migration } from "../Migration.js";

export const routineSessionArchiveMigration: Migration = {
  id: "20260928100000-routine-session-archive",
  sql: `ALTER TABLE halo_routines
    ADD COLUMN auto_archive_session INTEGER NOT NULL DEFAULT 0
    CHECK (auto_archive_session IN (0, 1));`,
};
