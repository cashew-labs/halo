import {
  collection,
  type CollectionDefinition,
} from "@tanishqkancharla/tandem-core";
import type { Field, SqlValue } from "./fields.js";

type Fields = Record<string, Field<unknown>> & { id: Field<string> };
type Values<Columns extends Fields> = {
  [Key in keyof Columns]: Columns[Key] extends Field<infer Value>
    ? Value
    : never;
};
type TableRecord<Columns extends Fields> = {
  [
    Key in keyof Columns as undefined extends Values<Columns>[Key] ? never : Key
  ]: Values<Columns>[Key];
} & {
  [
    Key in keyof Columns as undefined extends Values<Columns>[Key] ? Key : never
  ]?: Values<Columns>[Key];
} & { id: string };

type Relation = {
  type: "many-to-one" | "one-to-many";
  targetCollection: string;
  from: string;
  to: string;
};

export function defineTable<
  Columns extends Fields,
  const Relations extends Record<string, Relation>,
>(input: { table: string; fields: Columns; relations: Relations }) {
  const entries = Object.entries(input.fields);
  const columns = entries.map(([name, field]) => field.column ?? name);
  // SAFETY: Object.keys returns precisely the declared field names.
  const fields = Object.keys(input.fields) as (keyof TableRecord<Columns> &
    string)[];
  const definition: CollectionDefinition<TableRecord<Columns>> = {
    ...collection<TableRecord<Columns>>({ fields }),
    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Tandem's public property name.
    shape: input.fields,
  };
  // Identifiers come only from these source-controlled table definitions.
  const quotedColumns = columns.map(quoteIdentifier);
  const table = quoteIdentifier(input.table);
  return {
    collection: definition,
    relations: input.relations,
    select: `SELECT ${quotedColumns.join(", ")} FROM ${table}`,
    remove: `DELETE FROM ${table} WHERE tuple_key = ?`,
    upsert: `INSERT INTO ${table} (tuple_key, ${quotedColumns.join(", ")})
      VALUES (?, ${columns.map(() => "?").join(", ")})
      ON CONFLICT(tuple_key) DO UPDATE SET ${quotedColumns.map((column) => `${column} = excluded.${column}`).join(", ")}`,
    encode(record: TableRecord<Columns>) {
      return fields.map((name) => {
        const field: Field<unknown> = input.fields[name]!;
        return field.encode(record[name]);
      });
    },
    decode(row: Record<string, SqlValue>) {
      // SAFETY: The projection and field decoders are generated from the same shape.
      return Object.fromEntries(
        entries.map(([name, field]) => [
          name,
          field.decode(row[field.column ?? name]!),
        ]),
      ) as TableRecord<Columns>;
    },
  };
}

function quoteIdentifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}
