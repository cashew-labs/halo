import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
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
  message: "rpc.json: $detail",
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

export async function writeHaloRpcFile(options: {
  userDataDir: string;
  connection: { port: number; token: string };
}) {
  const file: HaloRpcFile = {
    version: 1,
    host: "127.0.0.1",
    port: options.connection.port,
    token: options.connection.token,
  };
  const written = await writeFile(
    rpcFilePath(options.userDataDir),
    `${JSON.stringify(file)}\n`,
    { mode: 0o600 },
  ).catch((cause) => new HaloRpcFileError({ detail: "write failed", cause }));
  if (written instanceof Error) return written;
  return file;
}

export async function removeHaloRpcFile(options: { userDataDir: string }) {
  return await rm(rpcFilePath(options.userDataDir), { force: true }).catch(
    (cause) => new HaloRpcFileError({ detail: "remove failed", cause }),
  );
}
