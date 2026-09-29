import type { Migration } from "../Migration.js";
import { initialWorkspaceMigration } from "./20260921130000-initialWorkspace.js";
import { initialExecutorMigration } from "./20260921133000-initialExecutorMigration.js";
import { sessionStatusMigration } from "./20260921194000-sessionStatus.js";
import { routinesMigration } from "./20260925090000-routines.js";
import { personalRoutinesMigration } from "./20260928090000-personalRoutines.js";
import { routineSessionArchiveMigration } from "./20260928100000-routineSessionArchive.js";
import { cloudDocumentsTenantMigration } from "./20260928185000-cloudDocumentsTenant.js";

export const workspaceMigrations = [
  initialWorkspaceMigration,
  initialExecutorMigration,
  sessionStatusMigration,
  routinesMigration,
  personalRoutinesMigration,
  routineSessionArchiveMigration,
  cloudDocumentsTenantMigration,
] satisfies readonly Migration[];
