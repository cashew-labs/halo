import fs from "node:fs/promises";
import path from "node:path";
import { Database } from "@tursodatabase/database/compat";
import { expect, test as baseTest } from "vitest";
import { applyMigrations, type Migration } from "./Migration.js";
import { durableStorageMigration } from "./migrations/20261003100000-durableStorage.js";
import {
  migrateWorkspace,
  workspaceMigrations,
} from "./migrations/workspaceMigrations.js";

type MigrationFixture = {
  attemptOpen(migrations: readonly Migration[]): Database | Error;
  open(migrations: readonly Migration[]): Database;
  close(database: Database): void;
};

const migrationTest = baseTest.extend<{ migration: MigrationFixture }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixture callbacks require destructured parameters.
  migration: async ({}, use) => {
    const parent = path.resolve(
      import.meta.dirname,
      "../../../../tmp/databaseMigrations",
    );
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, "migration-"));
    const openConnections = new Set<Database>();
    const attemptOpen = (migrations: readonly Migration[]) => {
      const connection = new Database(path.join(directory, "state.db"));
      const migrated =
        migrations === workspaceMigrations
          ? migrateWorkspace(connection)
          : applyMigrations({ connection, migrations });
      if (migrated instanceof Error) {
        connection.close();
        return migrated;
      }
      openConnections.add(connection);
      return connection;
    };
    await use({
      attemptOpen,
      open(migrations) {
        const connection = attemptOpen(migrations);
        if (connection instanceof Error) throw connection;
        return connection;
      },
      close(connection) {
        connection.close();
        openConnections.delete(connection);
      },
    });
    for (const connection of openConnections) connection.close();
    await fs.rm(directory, { recursive: true, force: true });
  },
});

const initialMigration = {
  id: "20260921090000-initial",
  sql: `
    CREATE TABLE migration_effects (
      name TEXT PRIMARY KEY
    );
    INSERT INTO migration_effects (name) VALUES ('initial');
  `,
} satisfies Migration;

const failingMigration = {
  id: "20260921090200-failing",
  sql: `
    INSERT INTO migration_effects (name) VALUES ('before-failure');
    INSERT INTO missing_table (name) VALUES ('failure');
  `,
} satisfies Migration;

migrationTest(
  "applies each migration once across database restarts",
  ({ migration }) => {
    const migrations = [initialMigration];

    const first = migration.open(migrations);
    expect(effectNames(first)).toEqual(["initial"]);
    migration.close(first);

    const restarted = migration.open(migrations);
    expect(effectNames(restarted)).toEqual(["initial"]);
  },
);

migrationTest(
  "migrates legacy conversations while preserving workspace data",
  ({ migration }) => {
    const durableMigrationIndex = workspaceMigrations.indexOf(
      durableStorageMigration,
    );
    const legacyMigrations = workspaceMigrations.slice(
      0,
      durableMigrationIndex,
    );
    const legacy = migration.open(legacyMigrations);
    legacy.exec(`
      INSERT INTO halo_sessions (id, metadata, next_seq, stats, marked_done, read_receipt_cursor_id)
        VALUES ('old-session', '{"id":"old-session","createdAt":1}', 3, '{}', 1, 'answer');
      INSERT INTO halo_session_entries (session_id, id, seq, timestamp, type, payload)
        VALUES ('old-session', 'entry', 1, 1, 'message', '{"type":"message","message":{"role":"user","content":"Remember copper otter","timestamp":1}}');
      INSERT INTO halo_session_entries (session_id, id, parent_id, seq, timestamp, type, payload)
        VALUES ('old-session', 'answer', 'entry', 2, 2, 'message', '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Copper otter saved"}],"timestamp":2}}');
      INSERT INTO halo_session_values (session_id, namespace, key, seq, payload)
        VALUES ('old-session', 'namespace', 'value', 1, '{}');
      INSERT INTO halo_session_lists (session_id, namespace, key, seq, payload)
        VALUES ('old-session', 'namespace', 'list', 1, '{}');
      INSERT INTO halo_session_usage (session_id, id, seq, payload)
        VALUES ('old-session', 'usage', 1, '{}');
      INSERT INTO user_hotkeys (user_id, hotkeys)
        VALUES ('user', '{"command":"Ctrl+K"}');
      INSERT INTO halo_routines (id, name, cron, timezone, action, enabled, created_at, updated_at)
        VALUES ('routine', 'Daily notes', '0 8 * * *', 'UTC', '{"type":"runAgent","prompt":"Summarize"}', 0, 1, 1);
      INSERT INTO halo_routine_runs (id, routine_id, trigger, scheduled_for, session_id, status, started_at)
        VALUES ('running', 'routine', 'manual', 1, 'old-session', 'running', 1),
               ('completed', 'routine', 'manual', 2, 'old-session', 'completed', 2);
    `);
    migration.close(legacy);

    const upgraded = migration.open(workspaceMigrations);
    expect(
      upgraded
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table'
            AND name IN ('halo_session_entries', 'halo_session_values', 'halo_session_lists', 'halo_session_usage')`,
        )
        .all(),
    ).toEqual([]);
    expect(
      upgraded
        .prepare(
          "SELECT id, marked_done, read_receipt_cursor_id FROM halo_threads",
        )
        .all(),
    ).toEqual([
      { id: "old-session", marked_done: 1, read_receipt_cursor_id: "3" },
    ]);
    expect(
      upgraded
        .prepare(
          "SELECT json_extract(record, '$.data.message.content') AS content FROM entries ORDER BY id",
        )
        .all(),
    ).toEqual([
      { content: "Remember copper otter" },
      { content: '[{"type":"text","text":"Copper otter saved"}]' },
    ]);
    expect(
      upgraded
        .prepare("PRAGMA table_info(halo_threads)")
        .all()
        .map(
          (row) =>
            // SAFETY: SQLite's table_info pragma returns a name for every column.
            (row as { name: string }).name,
        ),
    ).toEqual(["id", "metadata", "marked_done", "read_receipt_cursor_id"]);
    expect(upgraded.prepare("SELECT * FROM user_hotkeys").all()).toEqual([
      { user_id: "user", hotkeys: '{"command":"Ctrl+K"}' },
    ]);
    // Existing routine history keeps its link to the migrated thread.
    expect(
      upgraded
        .prepare(
          "SELECT id, status, thread_id FROM halo_routine_runs ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "completed", status: "completed", thread_id: "old-session" },
      { id: "running", status: "running", thread_id: "old-session" },
    ]);
  },
);

migrationTest("rejects changes to an applied migration", ({ migration }) => {
  const initial = migration.open([initialMigration]);
  migration.close(initial);

  const changed = migration.attemptOpen([
    {
      ...initialMigration,
      sql: `${initialMigration.sql}\n-- changed after application`,
    },
  ]);
  expect(changed).toBeInstanceOf(Error);
});

migrationTest("rolls back SQL when a migration fails", ({ migration }) => {
  const initial = migration.open([initialMigration]);
  migration.close(initial);

  const failed = migration.attemptOpen([initialMigration, failingMigration]);
  expect(failed).toBeInstanceOf(Error);

  const recovered = migration.open([initialMigration]);
  expect(effectNames(recovered)).toEqual(["initial"]);
});

function effectNames(database: Database) {
  // SAFETY: The projection matches the table created by initialMigration.
  const rows = database
    .prepare("SELECT name FROM migration_effects ORDER BY rowid")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}
