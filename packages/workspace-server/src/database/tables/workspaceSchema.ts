import { haloSchema, type SchemaRecords } from "../schema/schema.js";
import { hotkeys } from "./hotkeys.js";
import { routines, routineRuns } from "./routines.js";
import { sessionState } from "./sessionState.js";

export const workspaceSchema = haloSchema.schema({
  hotkeys,
  routines,
  routineRuns,
  sessionState,
});
export type WorkspaceSchema = SchemaRecords<typeof workspaceSchema>;
