import {
  collection,
  defineSchema,
  defineRelations,
  type CollectionDefinition,
  type RelationsInput,
} from "@tanishqkancharla/tandem-core";
import type { Fields, Schema, SchemaRecords, TableRecord } from "./schema.js";

export function haloSchemaToTandemSchema<Definition extends Schema>(
  definitions: Definition,
) {
  // SAFETY: Registry keys and their field names are preserved in each collection.
  const collections = Object.fromEntries(
    Object.entries(definitions).map(([name, table]) => [
      name,
      collection<TableRecord<Fields>>({ fields: Object.keys(table.fields) }),
    ]),
  ) as {
    [Name in keyof Definition & string]: CollectionDefinition<
      SchemaRecords<Definition>[Name]
    >;
  };
  // SAFETY: Literal relation definitions are preserved; defineRelations validates joins at runtime.
  const relations = Object.fromEntries(
    Object.entries(definitions).map(([name, table]) => [name, table.relations]),
  ) as {
    [Name in keyof Definition & string]: Extract<
      Definition[Name]["relations"],
      NonNullable<RelationsInput<SchemaRecords<Definition>>[Name]>
    >;
  };
  const schema = defineSchema(collections);
  return { schema, relations: defineRelations(schema, () => relations) };
}
