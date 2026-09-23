import fs from "node:fs/promises";
import path from "node:path";
import { Database } from "@tursodatabase/database/compat";
import { expect, test as baseTest } from "vitest";
import { applyMigrations, type Migration } from "./Migration.js";

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
