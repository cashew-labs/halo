import type { Database } from "@tursodatabase/database/compat";
import { encodeTuple } from "tuple-database/helpers/codec.js";
import * as errore from "errore";
import { DatabaseError } from "../DatabaseError.js";
import type { Migration } from "../Migration.js";

const migrationId = "20261010100000-tandem";

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
          UNION ALL SELECT 'sessionState', id FROM halo_threads
          UNION ALL SELECT 'automations', id FROM halo_automations
          UNION ALL SELECT 'automationRuns', id FROM halo_automation_runs
          UNION ALL SELECT 'automationSync', CAST(id AS TEXT) FROM halo_automation_sync
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

    INSERT INTO halo_session_state
      SELECT keys.tuple_key, thread.id, thread.marked_done, thread.read_receipt_cursor_id
      FROM halo_threads AS thread JOIN halo_tandem_import_keys AS keys
        ON keys.collection = 'sessionState' AND keys.id = thread.id;

    ALTER TABLE halo_automations ADD COLUMN tuple_key BLOB;
    UPDATE halo_automations SET tuple_key = (
      SELECT tuple_key FROM halo_tandem_import_keys
      WHERE collection = 'automations' AND id = halo_automations.id
    );
    CREATE UNIQUE INDEX halo_automations_tuple_key ON halo_automations(tuple_key);

    ALTER TABLE halo_automation_runs ADD COLUMN tuple_key BLOB;
    ALTER TABLE halo_automation_runs ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
    UPDATE halo_automation_runs SET sequence = rowid, tuple_key = (
      SELECT tuple_key FROM halo_tandem_import_keys
      WHERE collection = 'automationRuns' AND id = halo_automation_runs.id
    );
    CREATE UNIQUE INDEX halo_automation_runs_tuple_key ON halo_automation_runs(tuple_key);
    CREATE UNIQUE INDEX halo_automation_runs_sequence ON halo_automation_runs(sequence);

    -- Tandem record IDs are strings. Preserve the native singleton's generation
    -- and allocate insertion order transactionally, even after old runs are removed.
    ALTER TABLE halo_automation_sync RENAME TO halo_automation_sync_import;
    CREATE TABLE halo_automation_sync (
      tuple_key BLOB PRIMARY KEY NOT NULL,
      id TEXT NOT NULL UNIQUE CHECK (id = '1'),
      generation INTEGER NOT NULL,
      next_run_sequence INTEGER NOT NULL
    );
    INSERT INTO halo_automation_sync
      SELECT keys.tuple_key, CAST(sync.id AS TEXT), sync.generation,
        (SELECT COALESCE(MAX(sequence), 0) + 1 FROM halo_automation_runs)
      FROM halo_automation_sync_import AS sync JOIN halo_tandem_import_keys AS keys
        ON keys.collection = 'automationSync' AND keys.id = CAST(sync.id AS TEXT);
    DROP TABLE halo_automation_sync_import;
    DROP TABLE halo_tandem_import_keys;
  `,
};
