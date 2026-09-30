import type { Migration } from "../Migration.js";

export const personalRoutinesMigration: Migration = {
  id: "20260928090000-personal-routines",
  sql: `
    CREATE TABLE halo_routines_new (
      id TEXT PRIMARY KEY NOT NULL,
      extension_id TEXT,
      name TEXT NOT NULL,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL,
      action TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      next_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO halo_routines_new SELECT * FROM halo_routines;

    CREATE TABLE halo_routine_runs_new (
      id TEXT PRIMARY KEY NOT NULL,
      routine_id TEXT NOT NULL REFERENCES halo_routines_new(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
      scheduled_for INTEGER NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('running', 'completed', 'failed', 'interrupted', 'skipped')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      error TEXT,
      UNIQUE (routine_id, scheduled_for)
    );
    INSERT INTO halo_routine_runs_new SELECT * FROM halo_routine_runs;
    DROP TABLE halo_routine_runs;
    DROP TABLE halo_routines;
    ALTER TABLE halo_routines_new RENAME TO halo_routines;
    ALTER TABLE halo_routine_runs_new RENAME TO halo_routine_runs;
    CREATE INDEX halo_routine_runs_started
      ON halo_routine_runs (routine_id, started_at);
  `,
};
