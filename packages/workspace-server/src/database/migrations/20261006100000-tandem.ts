import type { Database } from "@tursodatabase/database/compat";
import { encodeTuple } from "tuple-database/helpers/codec.js";
import * as errore from "errore";
import { DatabaseError } from "../DatabaseError.js";
import type { Migration } from "../Migration.js";

const migrationId = "20261006100000-tandem";

// Turso cannot register JS SQL functions. Stage codec-generated keys before the
// SQL migration, as we do for legacy threads. A failed import can be retried.
export function prepareTandem(connection: Database) {
  return errore.try({
    try: () => {
      if (
        connection
          .prepare("SELECT id FROM halo_migrations WHERE id = ?")
          .get(migrationId) !== undefined
      )
        return;
      connection.transaction(() => {
        connection.exec(`
          CREATE TABLE IF NOT EXISTS halo_tandem_import_keys (
            collection TEXT NOT NULL, id TEXT NOT NULL, tuple_key BLOB NOT NULL
          );
          DELETE FROM halo_tandem_import_keys;
        `);
        // SAFETY: Every arm projects a collection name and its stored record ID.
        const records = connection
          .prepare(`
          SELECT 'hotkeys' AS collection, json_extract(item.value, '$.id') AS id
            FROM user_hotkeys, json_each(user_hotkeys.hotkeys) AS item
          UNION ALL SELECT 'routines', id FROM halo_routines
          UNION ALL SELECT 'routineRuns', id FROM halo_routine_runs
          UNION ALL SELECT 'sessionState', id FROM halo_threads
        `)
          .all() as { collection: string; id: string }[];
        const insert = connection.prepare(
          "INSERT INTO halo_tandem_import_keys VALUES (?, ?, ?)",
        );
        for (const { collection, id } of records) {
          const key = Buffer.from(
            encodeTuple(["record", collection, id]),
            "utf16le",
          ).swap16();
          insert.run(collection, id, key);
        }
      })();
    },
    catch: (cause) =>
      new DatabaseError({ operation: "prepare Tandem import", cause }),
  });
}

export const tandemMigration: Migration = {
  id: migrationId,
  sql: `
    CREATE TABLE halo_tandem_tuples (
      namespace TEXT NOT NULL, key BLOB NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (namespace, key)
    );
    CREATE TABLE halo_hotkeys (
      tuple_key BLOB PRIMARY KEY NOT NULL,
      id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      accelerator TEXT NOT NULL,
      action TEXT NOT NULL,
      position INTEGER NOT NULL
    );
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
    CREATE TABLE halo_session_state (
      tuple_key BLOB PRIMARY KEY NOT NULL,
      id TEXT NOT NULL UNIQUE,
      marked_done INTEGER NOT NULL,
      read_receipt_cursor_id TEXT
    );

    INSERT INTO halo_hotkeys
      SELECT keys.tuple_key, json_extract(item.value, '$.id'), owner.user_id,
        json_extract(item.value, '$.label'), json_extract(item.value, '$.accelerator'),
        json_extract(item.value, '$.action'), CAST(item.key AS INTEGER)
      FROM user_hotkeys AS owner, json_each(owner.hotkeys) AS item
      JOIN halo_tandem_import_keys AS keys
        ON keys.collection = 'hotkeys' AND keys.id = json_extract(item.value, '$.id');

    INSERT INTO halo_routine_history
      SELECT keys.tuple_key, run.id, run.routine_id, run.trigger,
        strftime('%Y-%m-%dT%H:%M:%fZ', run.scheduled_for / 1000.0, 'unixepoch'),
        run.thread_id, run.status,
        strftime('%Y-%m-%dT%H:%M:%fZ', run.started_at / 1000.0, 'unixepoch'),
        strftime('%Y-%m-%dT%H:%M:%fZ', run.finished_at / 1000.0, 'unixepoch'),
        run.error, run.rowid
      FROM halo_routine_runs AS run JOIN halo_tandem_import_keys AS keys
        ON keys.collection = 'routineRuns' AND keys.id = run.id;

    INSERT INTO halo_routine_definitions
      SELECT keys.tuple_key, routine.id, routine.extension_id, routine.name,
        routine.cron, routine.timezone, routine.action, routine.enabled,
        routine.auto_archive_thread,
        strftime('%Y-%m-%dT%H:%M:%fZ', routine.next_run_at / 1000.0, 'unixepoch'),
        strftime('%Y-%m-%dT%H:%M:%fZ', routine.created_at / 1000.0, 'unixepoch'),
        strftime('%Y-%m-%dT%H:%M:%fZ', routine.updated_at / 1000.0, 'unixepoch'),
        (SELECT run.id FROM halo_routine_runs AS run
          WHERE run.routine_id = routine.id AND run.status != 'skipped'
          ORDER BY run.started_at DESC, run.rowid DESC LIMIT 1),
        COALESCE((SELECT MAX(run.rowid) FROM halo_routine_runs AS run
          WHERE run.routine_id = routine.id), 0)
      FROM halo_routines AS routine JOIN halo_tandem_import_keys AS keys
        ON keys.collection = 'routines' AND keys.id = routine.id;

    INSERT INTO halo_session_state
      SELECT keys.tuple_key, thread.id, thread.marked_done, thread.read_receipt_cursor_id
      FROM halo_threads AS thread JOIN halo_tandem_import_keys AS keys
        ON keys.collection = 'sessionState' AND keys.id = thread.id;
    DROP TABLE halo_tandem_import_keys;
  `,
};
