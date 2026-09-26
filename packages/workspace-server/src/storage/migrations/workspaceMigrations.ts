import type { Migration } from "../Migration.js";
import { initialExecutorMigration } from "./20260921133000-initialExecutorMigration.js";
import { sessionStatusMigration } from "./20260921194000-sessionStatus.js";
import { initialWorkspaceMigration } from "./20260921130000-initialWorkspace.js";
import { routinesMigration } from "./20260925090000-routines.js";

export const workspaceMigrations = [
  initialWorkspaceMigration,
  initialExecutorMigration,
  sessionStatusMigration,
  routinesMigration,
] satisfies readonly Migration[];
