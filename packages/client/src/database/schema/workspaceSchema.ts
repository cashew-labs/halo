import { haloSchema, type SchemaRecords } from "./schema.js";
import { hotkeys } from "./hotkeys.js";
import { sessionState } from "./sessionState.js";
import { automations, automationRuns, automationSync } from "./automations.js";

export const workspaceSchema = haloSchema.schema({
  hotkeys,
  sessionState,
  automations,
  automationRuns,
  automationSync,
});
export type WorkspaceSchema = SchemaRecords<typeof workspaceSchema>;
