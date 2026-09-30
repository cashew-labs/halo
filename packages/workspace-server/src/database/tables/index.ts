import {
  defineRelations,
  defineSchema,
  type SchemaFromCollections,
} from "@tanishqkancharla/tandem-core";
import { hotkeys } from "./hotkeys.js";
import { routines } from "./routines.js";
import { routineRuns } from "./routineRuns.js";

export const tables = { hotkeys, routines, routineRuns };
export const schema = defineSchema(project("collection"));
export const relations = defineRelations(schema, () => project("relations"));
export type WorkspaceSchema = SchemaFromCollections<typeof schema.collections>;

function project<Property extends "collection" | "relations">(
  property: Property,
) {
  // SAFETY: Each registry key is preserved and paired with its own table property.
  return Object.fromEntries(
    Object.entries(tables).map(([name, table]) => [name, table[property]]),
  ) as {
    [Name in keyof typeof tables]: (typeof tables)[Name][Property];
  };
}
