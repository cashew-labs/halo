import { haloSchema, type SchemaRecords } from "./schema.js";
import { hotkeys } from "./hotkeys.js";
import { sessionState } from "./sessionState.js";

export const workspaceSchema = haloSchema.schema({
  hotkeys,
  sessionState,
});
export type WorkspaceSchema = SchemaRecords<typeof workspaceSchema>;
