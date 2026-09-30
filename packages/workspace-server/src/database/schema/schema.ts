declare const fieldValue: unique symbol;

export type Field<Value> = {
  type: "id" | "string" | "number" | "boolean" | "json";
  column?: string;
  nullable?: boolean;
  readonly [fieldValue]?: Value;
};
export type Fields = Record<string, Field<unknown>> & { id: Field<string> };
type Values<Columns extends Fields> = {
  [Key in keyof Columns]: Columns[Key] extends Field<infer Value>
    ? Value
    : never;
};
export type TableRecord<Columns extends Fields> = {
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
export type Table = {
  table: string;
  fields: Fields;
  relations: Record<string, Relation>;
};
export type Schema = Record<string, Table>;
export type SchemaRecords<Definition extends Schema> = {
  [Name in keyof Definition & string]: TableRecord<Definition[Name]["fields"]>;
};

function table<
  Columns extends Fields,
  const Relations extends Record<string, Relation>,
>(definition: { table: string; fields: Columns; relations: Relations }) {
  return definition;
}

function schema<Definition extends Schema>(definitions: Definition) {
  return definitions;
}

function id(): Field<string> {
  return { type: "id" };
}
function text<Value extends string = string>(column?: string): Field<Value> {
  return { type: "string", column };
}
function number(column?: string): Field<number> {
  return { type: "number", column };
}
function boolean(column?: string): Field<boolean> {
  return { type: "boolean", column };
}
function json<Value>(column?: string): Field<Value> {
  return { type: "json", column };
}
function optional<Value>(field: Field<Value>): Field<Value | undefined> {
  return { ...field, nullable: true };
}

export const haloSchema = {
  table,
  schema,
  id,
  text,
  number,
  boolean,
  json,
  optional,
};
