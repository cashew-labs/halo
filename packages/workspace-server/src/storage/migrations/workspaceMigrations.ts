import type { Migration } from "../Migration.js";
import { initialWorkspaceMigration } from "./20260921130000-initialWorkspace.js";
import { initialExecutorMigration } from "./20260921133000-initialExecutorMigration.js";
import { sessionStatusMigration } from "./20260921194000-sessionStatus.js";
import { cloudDocumentsTenantMigration } from "./20260928185000-cloudDocumentsTenant.js";

export const workspaceMigrations = [
  initialWorkspaceMigration,
  initialExecutorMigration,
  sessionStatusMigration,
  cloudDocumentsTenantMigration,
] satisfies readonly Migration[];
