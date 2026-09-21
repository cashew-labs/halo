import type { Migration } from "../Migration.js";
import { initialWorkspaceMigration } from "./20260921130000-initialWorkspace.js";

export const workspaceMigrations = [
  initialWorkspaceMigration,
] satisfies readonly Migration[];
