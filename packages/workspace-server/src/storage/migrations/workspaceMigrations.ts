import type { Migration } from "../Migration.js";
import { initialExecutorMigration } from "./20260921133000-initialExecutorMigration.js";
import { sessionStatusMigration } from "./20260921194000-sessionStatus.js";
import { initialWorkspaceMigration } from "./20260921130000-initialWorkspace.js";

export const workspaceMigrations = [
  initialWorkspaceMigration,
  initialExecutorMigration,
  sessionStatusMigration,
] satisfies readonly Migration[];
