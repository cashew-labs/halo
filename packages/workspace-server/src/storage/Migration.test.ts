import fs from "node:fs/promises";
import path from "node:path";
import { Database } from "@tursodatabase/database/compat";
import { expect, test as baseTest } from "vitest";
import { applyMigrations, type Migration } from "./Migration.js";
import { migrateExecutorTenant } from "./migrateExecutorTenant.js";
import { initialWorkspaceMigration } from "./migrations/20260921130000-initialWorkspace.js";
import { initialExecutorMigration } from "./migrations/20260921133000-initialExecutorMigration.js";
import { sessionStatusMigration } from "./migrations/20260921194000-sessionStatus.js";
import { prepareLegacyThreads } from "./migrations/20261005100000-legacyThreads.js";
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

const secondMigration = {
  id: "20260921090100-second",
  sql: "INSERT INTO migration_effects (name) VALUES ('second');",
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

migrationTest("applies newly appended migrations in order", ({ migration }) => {
  const initial = migration.open([initialMigration]);
  migration.close(initial);

  const upgraded = migration.open([initialMigration, secondMigration]);
  expect(effectNames(upgraded)).toEqual(["initial", "second"]);
});

migrationTest(
  "rewrites Executor tenants only for the cloud Documents rollout",
  ({ migration }) => {
    const legacy = migration.open([
      initialWorkspaceMigration,
      initialExecutorMigration,
      sessionStatusMigration,
    ]);
    legacy.exec(`
    INSERT INTO integration (slug, plugin_id, created_at, updated_at, row_id, tenant)
      VALUES ('google', 'google', 0, 0, 'integration-old', '/home/node');
    INSERT INTO connection (integration, name, template, provider, item_ids, created_at, updated_at, row_id, tenant, owner, subject)
      VALUES ('google', 'work', 'oauth', 'provider', '[]', 0, 0, 'connection-old', '/home/node', 'owner', 'subject');
    INSERT INTO tool_policy (id, pattern, action, position, created_at, updated_at, row_id, tenant, owner, subject)
      VALUES ('policy', '*', 'allow', 'before', 0, 0, 'policy-old', '/home/node', 'owner', 'subject');
    INSERT INTO artifact (id, title, code, created_at, updated_at, row_id, tenant, owner, subject)
      VALUES ('artifact', 'Saved artifact', '', 0, 0, 'artifact-old', '/home/node', 'owner', 'subject');
    INSERT INTO integration (slug, plugin_id, created_at, updated_at, row_id, tenant)
      VALUES ('local', 'local', 0, 0, 'integration-local', '/tmp/local');
  `);
    migration.close(legacy);

    const upgraded = migration.open(workspaceMigrations);
    expect(
      upgraded
        .prepare(
          "SELECT tenant FROM integration WHERE row_id = 'integration-old'",
        )
        .get(),
    ).toEqual({ tenant: "/home/node" });
    const migrated = migrateExecutorTenant({
      connection: upgraded,
      fromTenant: "/home/node",
      toTenant: "/home/node/documents",
    });
    if (migrated instanceof Error) throw migrated;
    // SAFETY: Every selected Executor table has a non-null tenant column.
    const tenants = upgraded
      .prepare(`
      SELECT tenant FROM integration WHERE row_id = 'integration-old'
      UNION ALL SELECT tenant FROM connection WHERE row_id = 'connection-old'
      UNION ALL SELECT tenant FROM tool_policy WHERE row_id = 'policy-old'
      UNION ALL SELECT tenant FROM artifact WHERE row_id = 'artifact-old'
      UNION ALL SELECT tenant FROM integration WHERE row_id = 'integration-local'
    `)
      .all() as { tenant: string }[];
    expect(tenants.map(({ tenant }) => tenant)).toEqual([
      "/home/node/documents",
      "/home/node/documents",
      "/home/node/documents",
      "/home/node/documents",
      "/tmp/local",
    ]);
    migration.close(upgraded);

    const restarted = migration.open(workspaceMigrations);
    const migratedAgain = migrateExecutorTenant({
      connection: restarted,
      fromTenant: "/home/node",
      toTenant: "/home/node/documents",
    });
    if (migratedAgain instanceof Error) throw migratedAgain;
    expect(
      restarted.prepare("SELECT COUNT(*) AS count FROM integration").get(),
    ).toEqual({ count: 2 });
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

migrationTest(
  "upgrades a pre-status database without losing its conversation",
  ({ migration }) => {
    const old = migration.open([initialWorkspaceMigration]);
    old.exec(`
      INSERT INTO halo_sessions VALUES ('early','{"id":"early","createdAt":1}',2,'{}');
      INSERT INTO halo_session_entries (session_id,id,parent_id,seq,timestamp,type,payload)
        VALUES ('early','message',NULL,1,1,'message','{"message":{"role":"user","content":"Keep this early conversation","timestamp":1}}');
    `);
    migration.close(old);
    const upgraded = migration.open(workspaceMigrations);
    expect(
      upgraded
        .prepare(
          "SELECT id,marked_done,read_receipt_cursor_id FROM halo_threads",
        )
        .all(),
    ).toEqual([
      // oxlint-disable-next-line unicorn/no-null -- The database column uses SQL NULL.
      { id: "early", marked_done: 0, read_receipt_cursor_id: null },
    ]);
    expect(
      upgraded
        .prepare(
          "SELECT json_extract(record,'$.model[0].content') AS content FROM entries",
        )
        .all(),
    ).toEqual([{ content: "Keep this early conversation" }]);
    migration.close(upgraded);
    const restarted = migration.open(workspaceMigrations);
    expect(
      restarted.prepare("SELECT count(*) AS count FROM entries").get(),
    ).toEqual({ count: 1 });
  },
);

migrationTest(
  "preserves branches, compaction context, names, and read receipts after interrupted migration",
  ({ migration }) => {
    const durableIndex = workspaceMigrations.indexOf(durableStorageMigration);
    const old = migration.open(workspaceMigrations.slice(0, durableIndex));
    old.exec(`
    INSERT INTO halo_sessions VALUES ('history','{"id":"history","createdAt":1}',6,'{}',0,'run-id');
    INSERT INTO halo_session_entries (session_id,id,parent_id,seq,timestamp,type,payload) VALUES
      ('history','user',NULL,1,1,'message','{"type":"message","message":{"role":"user","content":"Long ago","timestamp":1}}'),
      ('history','assistant','user',2,2,'message','{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Original response"}],"timestamp":2}}'),
      ('history','compact','assistant',3,3,'compaction','{"summary":"Remember copper otter","retainedTail":[{"role":"user","content":"Keep this tail","timestamp":2}]}'),
      ('history','latest','compact',4,4,'message','{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"After compacting"}],"timestamp":4}}'),
      ('history','alternative','user',5,5,'message','{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Alternate response"}],"timestamp":5}}');
    INSERT INTO halo_session_values VALUES
      ('history','pi.branch.tip','main',5,'"latest"'),
      ('history','pi.branch.tip','other',5,'"alternative"'),
      ('history','pi.session.name','',5,'"Named conversation"'),
      ('history','pi.result','run-id',5,'{"tipId":"latest","status":"succeeded"}');
  `);
    expect(prepareLegacyThreads(old)).toBeUndefined();
    // Simulate a process exiting after the published schema change, using real SQL.
    expect(
      applyMigrations({
        connection: old,
        migrations: workspaceMigrations.slice(0, durableIndex + 1),
      }),
    ).toBeUndefined();
    migration.close(old);
    const upgraded = migration.open(workspaceMigrations);
    expect(
      upgraded.prepare("SELECT read_receipt_cursor_id FROM halo_threads").get(),
    ).toEqual({ read_receipt_cursor_id: "6" });
    expect(
      upgraded.prepare("SELECT count(*) AS count FROM conversations").get(),
    ).toEqual({ count: 2 });
    // SAFETY: The query projects the migrated JSON model and integer entry IDs.
    const compact = upgraded
      .prepare(
        "SELECT json_extract(record,'$.model') AS model,head,id FROM entries WHERE head IS NOT NULL",
      )
      .get() as { model: string; head: number; id: number };
    expect(compact.head).toBe(compact.id);
    expect(JSON.parse(compact.model)).toEqual([
      { role: "user", content: "Remember copper otter", timestamp: 3 },
      { role: "user", content: "Keep this tail", timestamp: 2 },
    ]);
    expect(
      upgraded
        .prepare(
          "SELECT json_extract(content,'$.name') AS name FROM document_revisions",
        )
        .get(),
    ).toEqual({ name: "Named conversation" });
    expect(
      upgraded.prepare("SELECT count(*) AS count FROM entries").get(),
    ).toEqual({ count: 6 });
    migration.close(upgraded);
    const reopened = migration.open(workspaceMigrations);
    expect(
      reopened.prepare("SELECT count(*) AS count FROM entries").get(),
    ).toEqual({ count: 6 });
  },
);

migrationTest(
  "leaves already-durable thread state unchanged",
  ({ migration }) => {
    const old = migration.open(workspaceMigrations.slice(0, -1));
    old.exec(
      `INSERT INTO halo_threads (id,metadata,read_receipt_cursor_id) VALUES ('current','{"id":"current","createdAt":1}','123');`,
    );
    migration.close(old);
    const upgraded = migration.open(workspaceMigrations);
    expect(
      upgraded.prepare("SELECT read_receipt_cursor_id FROM halo_threads").get(),
    ).toEqual({ read_receipt_cursor_id: "123" });
  },
);

migrationTest(
  "rejects broken legacy history before dropping source rows",
  ({ migration }) => {
    const old = migration.open(
      workspaceMigrations.slice(
        0,
        workspaceMigrations.indexOf(durableStorageMigration),
      ),
    );
    old.exec(`
    INSERT INTO halo_sessions VALUES ('broken','{"id":"broken","createdAt":1}',2,'{}',0,NULL);
    INSERT INTO halo_session_entries (session_id,id,parent_id,seq,timestamp,type,payload) VALUES ('broken','entry','missing',1,1,'message','{}');
  `);
    expect(migrateWorkspace(old)).toBeInstanceOf(Error);
    expect(
      old.prepare("SELECT count(*) AS count FROM halo_session_entries").get(),
    ).toEqual({ count: 1 });
  },
);

migrationTest(
  "creates thread storage with routine links and partition foreign keys",
  ({ migration }) => {
    const durable = migration.open(workspaceMigrations);
    durable.exec(`
      INSERT INTO halo_threads (id, metadata, marked_done, read_receipt_cursor_id)
        VALUES ('thread-1', '{"id":"thread-1","createdAt":1}', 1, 'cursor');
      INSERT INTO durable_metadata (thread_id, next_id, next_seq)
        VALUES ('thread-1', '3', 2);
      INSERT INTO record_ids (thread_id, id, record_type)
        VALUES ('thread-1', 1, 'conversation');
      INSERT INTO conversations (thread_id, id, record)
        VALUES ('thread-1', 1, '{"id":1}');
      INSERT INTO halo_routines (id, name, cron, timezone, action, enabled, created_at, updated_at, auto_archive_thread)
        VALUES ('routine', 'Daily notes', '0 8 * * *', 'UTC', '{"type":"runAgent","prompt":"Summarize"}', 1, 1, 1, 1);
      INSERT INTO halo_routine_runs (id, routine_id, trigger, scheduled_for, thread_id, status, started_at)
        VALUES ('run', 'routine', 'manual', 1, 'thread-1', 'completed', 1);
    `);
    migration.close(durable);

    const upgraded = migration.open(workspaceMigrations);
    expect(upgraded.prepare("SELECT * FROM halo_threads").all()).toEqual([
      {
        id: "thread-1",
        metadata: '{"id":"thread-1","createdAt":1}',
        marked_done: 1,
        read_receipt_cursor_id: "cursor",
      },
    ]);
    expect(
      upgraded
        .prepare("SELECT thread_id, next_id, next_seq FROM durable_metadata")
        .all(),
    ).toEqual([{ thread_id: "thread-1", next_id: "3", next_seq: 2 }]);
    expect(
      upgraded.prepare("SELECT thread_id FROM halo_routine_runs").all(),
    ).toEqual([{ thread_id: "thread-1" }]);
    expect(
      upgraded.prepare("SELECT auto_archive_thread FROM halo_routines").all(),
    ).toEqual([{ auto_archive_thread: 1 }]);

    const partitionTables = [
      "durable_metadata",
      "record_ids",
      "conversations",
      "entries",
      "tasks",
      "submissions",
      "documents",
      "document_revisions",
    ];
    for (const table of partitionTables) {
      expect(
        upgraded.prepare(`PRAGMA foreign_key_list(${table})`).all(),
      ).toContainEqual(
        expect.objectContaining({
          table: "halo_threads",
          from: "thread_id",
          to: "id",
          on_delete: "CASCADE",
        }),
      );
    }
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
