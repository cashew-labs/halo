import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";

export const haloRpcFileV1 = Type.Object({
  version: Type.Literal(1),
  host: Type.Literal("127.0.0.1"),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  token: Type.String({ minLength: 1 }),
});
export type HaloRpcFile = Static<typeof haloRpcFileV1>;

export class HaloRpcFileError extends errore.createTaggedError({
  name: "HaloRpcFileError",
  message: "Failed to read rpc.json: $detail",
}) {}

export function rpcFilePath(userDataDir: string) {
  return join(userDataDir, "rpc.json");
}

export async function readHaloRpcFile(path: string) {
  const raw = await readFile(path, "utf8").catch(
    (e) => new HaloRpcFileError({ detail: "read failed", cause: e }),
  );
  if (raw instanceof Error) return raw;

  const parsed = errore.try({
    try: () => {
      // SAFETY: JSON.parse is untyped; haloRpcFileV1 is the file contract.
      return JSON.parse(raw) as unknown;
    },
    catch: (e) => new HaloRpcFileError({ detail: "invalid JSON", cause: e }),
  });
  if (parsed instanceof Error) return parsed;
  if (Value.Check(haloRpcFileV1, parsed)) return parsed;

  const first = [...Value.Errors(haloRpcFileV1, parsed)][0];
  const errorPath = first === undefined ? "" : first.path;
  const message = first === undefined ? "invalid" : first.message;
  return new HaloRpcFileError({
    detail: errorPath.length === 0 ? message : `${errorPath} ${message}`,
  });
}
