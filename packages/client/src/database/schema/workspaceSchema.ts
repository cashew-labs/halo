import { haloSchema, type SchemaRecords } from "./schema.js";
import { favorites } from "./favorites.js";
import { hotkeys } from "./hotkeys.js";
import { memories } from "./memories.js";
import { threadState } from "./threadState.js";
import { automations, automationRuns, automationSync } from "./automations.js";
import { agents } from "./agents.js";

export const workspaceSchema = haloSchema.schema({
  agents,
  hotkeys,
  favorites,
  memories,
  // Tandem clients persist this collection name in their sync state.
  sessionState: threadState,
  automations,
  automationRuns,
  automationSync,
});
export type WorkspaceSchema = SchemaRecords<typeof workspaceSchema>;
