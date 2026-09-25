import type { Migration } from "../Migration.js";

export const routinesMigration: Migration = {
  id: "20260925090000-routines",
  sql: `
    CREATE TABLE halo_routines (
      id TEXT PRIMARY KEY NOT NULL,
      extension_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL,
      action TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      next_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE halo_routine_runs (
      id TEXT PRIMARY KEY NOT NULL,
      routine_id TEXT NOT NULL REFERENCES halo_routines(id) ON DELETE CASCADE,
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
    CREATE INDEX halo_routine_runs_started
      ON halo_routine_runs (routine_id, started_at);
  `,
};
