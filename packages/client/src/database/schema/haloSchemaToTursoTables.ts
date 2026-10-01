// oxlint-disable unicorn/no-null -- SQL bindings use null for absence.
import type { Field, Schema, Table, TableRecord } from "./schema.js";

export type SqlValue = string | number | null;

export function haloSchemaToTursoTables<Definition extends Schema>(
  definitions: Definition,
) {
  // SAFETY: Each registry key stays paired with the SQL mapping for its table definition.
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      toTursoTable(definition),
    ]),
  ) as {
    [Name in keyof Definition]: ReturnType<
      typeof toTursoTable<Definition[Name]>
    >;
  };
}

function toTursoTable<Definition extends Table>(definition: Definition) {
  const entries = Object.entries(definition.fields);
  const columns = entries.map(([name, field]) =>
    quoteIdentifier(field.column ?? name),
  );
  const table = quoteIdentifier(definition.table);
  return {
    select: `SELECT ${columns.join(", ")} FROM ${table}`,
    remove: `DELETE FROM ${table} WHERE tuple_key = ?`,
    upsert: `INSERT INTO ${table} (tuple_key, ${columns.join(", ")})
      VALUES (?, ${columns.map(() => "?").join(", ")})
      ON CONFLICT(tuple_key) DO UPDATE SET ${columns.map((column) => `${column} = excluded.${column}`).join(", ")}`,
    encode(record: TableRecord<Definition["fields"]>) {
      return entries.map(([name, field]) => {
        // SAFETY: These keys come from the same definition that derives the record type.
        const value = record[name as keyof typeof record];
        return encode({ field, value });
      });
    },
    decode(row: Record<string, SqlValue>) {
      // SAFETY: The generated projection and decoders share the record's field definition.
      return Object.fromEntries(
        entries.map(([name, field]) => [
          name,
          decode({ field, value: row[field.column ?? name]! }),
        ]),
      ) as TableRecord<Definition["fields"]>;
    },
  };
}

function encode({
  field,
  value,
}: {
  field: Field<unknown>;
  value: unknown;
}): SqlValue {
  if (field.nullable && value === undefined) return null;
  if (field.type === "boolean") return value ? 1 : 0;
  if (field.type === "json") return JSON.stringify(value);
  // SAFETY: Remaining fields are typed text, IDs, or numbers in the table record.
  return value as string | number;
}

function decode<Value>({
  field,
  value,
}: {
  field: Field<Value>;
  value: SqlValue;
}): Value {
  // SAFETY: JSON fields are stored as text by this adapter.
  const decoded: unknown =
    field.nullable && value === null
      ? undefined
      : field.type === "boolean"
        ? value === 1
        : field.type === "json"
          ? JSON.parse(value as string)
          : value;
  // SAFETY: The field's declared value type matches its encoding in the domain table.
  return decoded as Value;
}

function quoteIdentifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}
