import type { Database } from "@tursodatabase/database/compat";
import { applyMigrations } from "../Migration.js";
import type { Migration } from "../Migration.js";
import { initialWorkspaceMigration } from "./20260921130000-initialWorkspace.js";
import { initialExecutorMigration } from "./20260921133000-initialExecutorMigration.js";
import { sessionStatusMigration } from "./20260921194000-sessionStatus.js";
import { routinesMigration } from "./20260925090000-routines.js";
import { personalRoutinesMigration } from "./20260928090000-personalRoutines.js";
import { routineSessionArchiveMigration } from "./20260928100000-routineSessionArchive.js";
import { durableStorageMigration } from "./20261003100000-durableStorage.js";
import { prepareTandem, tandemMigration } from "./20261006100000-tandem.js";

import {
  legacyThreadsMigration,
  prepareLegacyThreads,
} from "./20261005100000-legacyThreads.js";

export const workspaceMigrations = [
  initialWorkspaceMigration,
  initialExecutorMigration,
  sessionStatusMigration,
  routinesMigration,
  personalRoutinesMigration,
  routineSessionArchiveMigration,
  durableStorageMigration,
  legacyThreadsMigration,
  tandemMigration,
] satisfies readonly Migration[];

export function migrateWorkspace(connection: Database) {
  // Verify the complete ledger, but add legacy columns before staging their rows.
  const prerequisites = applyMigrations({
    connection,
    migrations: workspaceMigrations,
    stopBefore: durableStorageMigration.id,
  });
  if (prerequisites instanceof Error) return prerequisites;
  const prepared = prepareLegacyThreads(connection);
  if (prepared instanceof Error) return prepared;
  const legacy = applyMigrations({
    connection,
    migrations: workspaceMigrations,
    stopBefore: tandemMigration.id,
  });
  if (legacy instanceof Error) return legacy;
  const tandem = prepareTandem(connection);
  if (tandem instanceof Error) return tandem;
  return applyMigrations({ connection, migrations: workspaceMigrations });
}
