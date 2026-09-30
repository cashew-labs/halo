import fs from "node:fs/promises";
import path from "node:path";
import { Database } from "@tursodatabase/database/compat";
import { expect, test as baseTest } from "vitest";
import { applyMigrations, type Migration } from "./Migration.js";
import { migrateExecutorTenant } from "./migrateExecutorTenant.js";
import { initialWorkspaceMigration } from "./migrations/20260921130000-initialWorkspace.js";
import { initialExecutorMigration } from "./migrations/20260921133000-initialExecutorMigration.js";
import { sessionStatusMigration } from "./migrations/20260921194000-sessionStatus.js";
import { workspaceMigrations } from "./migrations/workspaceMigrations.js";

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
      const migrated = applyMigrations({ connection, migrations });
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
