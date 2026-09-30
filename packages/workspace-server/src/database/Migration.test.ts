import fs from "node:fs/promises";
import path from "node:path";
import { Database } from "@tursodatabase/database/compat";
import { expect, test as baseTest, vi } from "vitest";
import * as errore from "errore";
import { DatabaseService } from "./DatabaseService.js";
import { FilesystemService } from "../filesystem/FilesystemService.js";
import { applyMigrations, type Migration } from "./Migration.js";
import { migrateExecutorTenant } from "./migrateExecutorTenant.js";
import { initialWorkspaceMigration } from "./migrations/20260921130000-initialWorkspace.js";
import { initialExecutorMigration } from "./migrations/20260921133000-initialExecutorMigration.js";
import { sessionStatusMigration } from "./migrations/20260921194000-sessionStatus.js";
import { workspaceMigrations } from "./migrations/workspaceMigrations.js";
import { TursoTupleStorage } from "./TursoTupleStorage.js";
import type { WorkspaceSchema } from "./tables/workspaceSchema.js";

type MigrationFixture = {
  directory: string;
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
      const migrated = applyMigrations({ connection, migrations });
      if (migrated instanceof Error) {
        connection.close();
        return migrated;
      }
      openConnections.add(connection);
      return connection;
    };
    await use({
      directory,
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

migrationTest(
  "domain table definitions round-trip migrated data and roll back mixed writes",
  async ({ migration }) => {
    const connection = migration.open(workspaceMigrations);
    const storage = new TursoTupleStorage({
      database: { access: async (operation) => await operation(connection) },
    });
    const hotkey: WorkspaceSchema["hotkeys"] = {
      id: "key",
      userId: "owner",
      label: "Launch",
      accelerator: "Ctrl+L",
      action: { type: "runAgent", prompt: "Say 'hello'" },
      position: 7,
    };
    const routine: WorkspaceSchema["routines"] = {
      id: "routine",
      name: "Morning",
      cron: "0 8 * * *",
      timezone: "UTC",
      action: { type: "runAgent", prompt: "Read inbox" },
      enabled: false,
      autoArchiveSession: true,
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T01:00:00.000Z",
      runSequence: 3,
      lastRunId: "run",
      extensionId: "mail",
    };
    const run: WorkspaceSchema["routineRuns"] = {
      id: "run",
      routineId: routine.id,
      trigger: "manual",
      status: "failed",
      scheduledFor: routine.createdAt,
      startedAt: routine.updatedAt,
      sequence: 3,
      sessionId: "session",
      finishedAt: "2026-09-30T01:01:00.000Z",
      error: "Exit 1",
    };
    await storage.commit({
      set: [
        { key: ["record", "routines", routine.id], value: routine },
        { key: ["record", "hotkeys", hotkey.id], value: hotkey },
        { key: ["record", "routineRuns", run.id], value: run },
      ],
    });
    expect((await storage.scan()).map(({ value }) => value)).toEqual([
      hotkey,
      run,
      routine,
    ]);
    // Check the existing SQL layout independently of the generated decoder.
    expect(
      connection
        .prepare(`SELECT extension_id, action, enabled, auto_archive_session,
      created_at, updated_at, last_run_id, run_sequence FROM halo_routine_definitions`)
        .get(),
    ).toEqual({
      extension_id: "mail",
      action: '{"type":"runAgent","prompt":"Read inbox"}',
      enabled: 0,
      auto_archive_session: 1,
      created_at: "2026-09-30T00:00:00.000Z",
      updated_at: "2026-09-30T01:00:00.000Z",
      last_run_id: "run",
      run_sequence: 3,
    });
    expect(
      (await storage.scan({ reverse: true, limit: 2 })).map(
        ({ value }) => value,
      ),
    ).toEqual([routine, run]);
    expect(
      (
        await storage.scan({
          gt: ["record", "hotkeys", hotkey.id],
          lte: ["record", "routineRuns", run.id],
        })
      ).map(({ value }) => value),
    ).toEqual([run]);
    const updated = {
      ...routine,
      enabled: true,
      autoArchiveSession: false,
      extensionId: undefined,
      lastRunId: undefined,
    };
    await storage.commit({
      remove: [["record", "routines", routine.id]],
      set: [{ key: ["record", "routines", routine.id], value: updated }],
    });
    expect(
      (await storage.scan({ gte: ["record", "routines"], limit: 1 }))[0]?.value,
    ).toEqual(updated);
    await expect(
      storage.commit({
        remove: [["record", "hotkeys", hotkey.id]],
        set: [{ key: ["record", "routines", "duplicate-id"], value: routine }],
      }),
    ).rejects.toThrow();
    expect((await storage.scan()).map(({ value }) => value)).toEqual([
      hotkey,
      run,
      updated,
    ]);
    await storage.close();
  },
);

migrationTest(
  "disposes abandoned transactions without canceling committed attempts",
  async ({ migration }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const filesystem = new FilesystemService();
    cleanup.defer(async () => {
      const closed = await filesystem.close();
      if (closed instanceof Error) throw closed;
    });
    const db = await DatabaseService.open({
      directory: migration.directory,
      filesystem,
    });
    if (db instanceof Error) throw db;
    cleanup.defer(async () => {
      const closed = await db.close();
      if (closed instanceof Error) throw closed;
    });
    using warnings = vi.spyOn(console, "warn");
    const abandoned = await (async () => {
      await using tx = db.useTransaction();
      await tx.get("sessionState", "session");
      tx.set("sessionState", { id: "session", markedDone: true });
      return tx;
    })();
    await expect(abandoned.get("sessionState", "session")).rejects.toThrow();
    expect(await db.query({ collection: "sessionState" })).toEqual([]);

    const updates: WorkspaceSchema["sessionState"][][] = [];
    const subscription = await db.subscribe(
      { collection: "sessionState" },
      (records) => updates.push(records),
    );
    cleanup.defer(() => subscription.destroy());
    expect(subscription.result).toEqual([]);
    {
      await using tx = db.useTransaction();
      tx.set("sessionState", { id: "session", markedDone: false });
      await db.commit(tx);
    }
    await expect
      .poll(() => updates.at(-1))
      .toEqual([{ id: "session", markedDone: false }]);

    // A competing write makes commit reject after consuming the transaction.
    {
      await using tx = db.useTransaction();
      await tx.get("sessionState", "session");
      const writer = db.transact();
      writer.set("sessionState", { id: "session", markedDone: true });
      await db.commit(writer);
      tx.set("sessionState", { id: "session", markedDone: false });
      await expect(db.commit(tx)).rejects.toThrow();
    }
    expect(await db.query({ collection: "sessionState" })).toEqual([
      { id: "session", markedDone: true },
    ]);
    {
      await using tx = db.useTransaction();
      await tx.get("sessionState", "session");
      await tx.cancel();
    }
    expect(warnings).not.toHaveBeenCalled();
  },
);

function effectNames(database: Database) {
  // SAFETY: The projection matches the table created by initialMigration.
  const rows = database
    .prepare("SELECT name FROM migration_effects ORDER BY rowid")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}
