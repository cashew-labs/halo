// oxlint-disable unicorn/no-null -- Turso bindings represent absence with SQL NULL.
import { t, type RuntimeFieldDefinition } from "@tanishqkancharla/tandem-core";

export type SqlValue = string | number | null;

export type Field<Value> = RuntimeFieldDefinition<Value> & {
  column?: string;
  encode(value: Value): SqlValue;
  decode(value: SqlValue): Value;
};

export function text<Value extends string = string>(
  column?: string,
): Field<Value> {
  return {
    kind: "field",
    type: "string",
    column,
    encode: (value) => value,
    // SAFETY: Domain text columns are written from this field's typed records.
    decode: (value) => value as Value,
  };
}

export function id(): Field<string> {
  return { ...text(), ...t.id() };
}

export function number(column?: string): Field<number> {
  return {
    ...t.number(),
    column,
    encode: (value) => value,
    // SAFETY: Numeric domain columns are written as numbers by this field.
    decode: (value) => value as number,
  };
}

export function booleanInteger(column?: string): Field<boolean> {
  return {
    ...t.boolean(),
    column,
    encode: (value) => (value ? 1 : 0),
    decode: (value) => value === 1,
  };
}

export function json<Value>(column?: string): Field<Value> {
  return {
    kind: "field",
    type: "json",
    column,
    encode: (value) => JSON.stringify(value),
    // SAFETY: JSON columns contain records encoded by this same field, not external input.
    decode: (value) => JSON.parse(value as string) as Value,
  };
}

export function optional<Value>(field: Field<Value>): Field<Value | undefined> {
  return {
    ...field,
    encode: (value) => (value === undefined ? null : field.encode(value)),
    decode: (value) => (value === null ? undefined : field.decode(value)),
  };
}
