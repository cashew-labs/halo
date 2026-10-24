import { haloSchema, type SchemaRecords } from "./schema.js";
import { favorites } from "./favorites.js";
import { hotkeys } from "./hotkeys.js";
import { threadState } from "./threadState.js";
import { automations, automationRuns, automationSync } from "./automations.js";

export const workspaceSchema = haloSchema.schema({
  hotkeys,
  favorites,
  // Tandem clients persist this collection name in their sync state.
  sessionState: threadState,
  automations,
  automationRuns,
  automationSync,
});
export type WorkspaceSchema = SchemaRecords<typeof workspaceSchema>;
