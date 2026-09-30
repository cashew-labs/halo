import type { Migration } from "../Migration.js";
import { initialWorkspaceMigration } from "./20260921130000-initialWorkspace.js";
import { initialExecutorMigration } from "./20260921133000-initialExecutorMigration.js";
import { sessionStatusMigration } from "./20260921194000-sessionStatus.js";
import { routinesMigration } from "./20260925090000-routines.js";
import { personalRoutinesMigration } from "./20260928090000-personalRoutines.js";
import { routineSessionArchiveMigration } from "./20260928100000-routineSessionArchive.js";
import { tandemTuplesMigration } from "./20260929130000-tandemTuples.js";
import { tandemHotkeysMigration } from "./20260930120000-tandemHotkeys.js";
import { tandemRoutinesMigration } from "./20260930130000-tandemRoutines.js";

export const workspaceMigrations = [
  initialWorkspaceMigration,
  initialExecutorMigration,
  sessionStatusMigration,
  routinesMigration,
  personalRoutinesMigration,
  routineSessionArchiveMigration,
  tandemTuplesMigration,
  tandemHotkeysMigration,
  tandemRoutinesMigration,
] satisfies readonly Migration[];
