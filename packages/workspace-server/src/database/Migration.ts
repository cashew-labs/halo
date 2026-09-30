import crypto from "node:crypto";
import type { Database } from "@tursodatabase/database/compat";
import * as errore from "errore";
import { DatabaseError } from "./DatabaseError.js";

export type Migration = Readonly<{
  id: string;
  sql: string;
}>;

type AppliedMigration = {
  id: string;
  checksum: string;
};

const migrationIdPattern = /^\d{14}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

const migrationLedgerSql = `
  CREATE TABLE IF NOT EXISTS halo_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )
`;

export function applyMigrations(input: {
  connection: Database;
  migrations: readonly Migration[];
}) {
  const valid = validate(input.migrations);
  if (valid instanceof Error) return valid;
  const ledger = errore.try({
    try: () => input.connection.exec(migrationLedgerSql),
    catch: (cause) =>
      new DatabaseError({
        operation: "initialize migrations",
        cause,
      }),
  });
  if (ledger instanceof Error) return ledger;

  const applied = errore.try({
    try: () => {
      // SAFETY: The projection matches the migration ledger created above.
      return input.connection
        .prepare("SELECT id, checksum FROM halo_migrations ORDER BY id")
        .all() as AppliedMigration[];
    },
    catch: (cause) =>
      new DatabaseError({
        operation: "read migrations",
        cause,
      }),
  });
  if (applied instanceof Error) return applied;

  const verified = verifyApplied(input.migrations, applied);
  if (verified instanceof Error) return verified;

  for (const migration of input.migrations.slice(verified)) {
    const checksum = checksumFor(migration);
    const result = errore.try({
      try: () =>
        input.connection.transaction(() => {
          input.connection.exec(migration.sql);
          input.connection
            .prepare(
              `INSERT INTO halo_migrations (id, checksum, applied_at)
               VALUES (?, ?, ?)`,
            )
            .run(migration.id, checksum, Date.now());
        })(),
      catch: (cause) =>
        new DatabaseError({
          operation: `apply migration ${migration.id}`,
          cause,
        }),
    });
    if (result instanceof Error) return result;
  }
}

function validate(migrations: readonly Migration[]) {
  for (const [index, migration] of migrations.entries()) {
    if (!migrationIdPattern.test(migration.id))
      return migrationError(
        migration.id,
        "ID must use YYYYMMDDHHMMSS-name format",
      );
    const previous = migrations[index - 1];
    if (previous !== undefined && migration.id <= previous.id)
      return migrationError(
        migration.id,
        "IDs must be unique and strictly increasing",
      );
  }
}

function verifyApplied(
  migrations: readonly Migration[],
  applied: readonly AppliedMigration[],
) {
  for (const [index, record] of applied.entries()) {
    const migration = migrations[index];
    if (migration === undefined)
      return migrationError(
        record.id,
        "applied migration was removed from the registry",
      );
    if (migration.id !== record.id)
      return migrationError(
        record.id,
        `applied history is not a prefix of the registry at ${migration.id}`,
      );
    if (checksumFor(migration) !== record.checksum)
      return migrationError(record.id, "applied migration SQL was changed");
  }
  return applied.length;
}

function checksumFor(migration: Migration) {
  return crypto.createHash("sha256").update(migration.sql).digest("hex");
}

function migrationError(id: string, detail: string) {
  return new DatabaseError({
    operation: `validate migration ${id}`,
    cause: new Error(detail),
  });
}
