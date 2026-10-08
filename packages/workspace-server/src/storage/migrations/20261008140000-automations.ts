import type { Migration } from "../Migration.js";

export const automationsMigration: Migration = {
  id: "20261008140000-automations",
  sql: `
    CREATE TABLE halo_automations (
      id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL,
      extension_id TEXT,
      name TEXT NOT NULL,
      activation TEXT NOT NULL,
      action TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      auto_archive_thread INTEGER NOT NULL CHECK (auto_archive_thread IN (0, 1)),
      next_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO halo_automations
      SELECT id, 1, extension_id, name,
        json_object('type', 'routine', 'schedule', json_object('cron', cron, 'timezone', timezone)),
        action, enabled, auto_archive_thread, next_run_at, created_at, updated_at
      FROM halo_routines;
    CREATE TABLE halo_automation_runs (
      id TEXT PRIMARY KEY NOT NULL,
      automation_id TEXT NOT NULL REFERENCES halo_automations(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'event')),
      event_id TEXT UNIQUE,
      scheduled_for INTEGER NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled', 'skipped')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      error TEXT,
      snapshot TEXT,
      payload TEXT
    );
    INSERT INTO halo_automation_runs
      (id, automation_id, revision, trigger, scheduled_for, thread_id, status, started_at, finished_at, error)
      SELECT id, routine_id, 1, trigger, scheduled_for, thread_id, status, started_at, finished_at, error
      FROM halo_routine_runs;
    CREATE INDEX halo_automation_runs_started ON halo_automation_runs (automation_id, started_at);
    CREATE INDEX halo_automation_runs_status ON halo_automation_runs (status, started_at);
    DROP TABLE halo_routine_runs;
    DROP TABLE halo_routines;
  `,
};
