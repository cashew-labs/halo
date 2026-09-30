import type { Migration } from "../Migration.js";

export const tandemRoutinesMigration: Migration = {
  id: "20260930130000-tandem-routines",
  sql: `
    CREATE TABLE halo_routine_definitions (
      tuple_key BLOB PRIMARY KEY NOT NULL,
      id TEXT NOT NULL UNIQUE,
      extension_id TEXT,
      name TEXT NOT NULL,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL,
      action TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      auto_archive_session INTEGER NOT NULL CHECK (auto_archive_session IN (0, 1)),
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_run_id TEXT,
      run_sequence INTEGER NOT NULL
    );
    CREATE TABLE halo_routine_history (
      tuple_key BLOB PRIMARY KEY NOT NULL,
      id TEXT NOT NULL UNIQUE,
      routine_id TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
      scheduled_for TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted', 'skipped')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT,
      sequence INTEGER NOT NULL
    );
  `,
};
