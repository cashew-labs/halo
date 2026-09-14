import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const argumentRecordSchema = Type.Record(Type.String(), Type.Unknown());

export function parseToolArgumentRows(args: { value: unknown }) {
  if (!Value.Check(argumentRecordSchema, args.value)) return undefined;
  return Object.entries(args.value).map(([name, value]) => {
    if (Value.Check(Type.String(), value)) return { name, value };
    const encoded = JSON.stringify(value);
    if (Value.Check(Type.String(), encoded)) return { name, value: encoded };
    return { name, value: "null" };
  });
}
