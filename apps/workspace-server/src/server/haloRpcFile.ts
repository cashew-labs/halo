import fs from "node:fs/promises";
import { rpcFilePath, type HaloRpcFile } from "@halo/cli";
import * as errore from "errore";

export class HaloRpcDiscoveryError extends errore.createTaggedError({
  name: "HaloRpcDiscoveryError",
  message: "Halo RPC discovery failed: $detail",
}) {}

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
  const written = await fs
    .writeFile(rpcFilePath(options.userDataDir), `${JSON.stringify(file)}\n`, {
      mode: 0o600,
    })
    .catch(
      (cause) => new HaloRpcDiscoveryError({ detail: "write rpc.json", cause }),
    );
  if (written instanceof Error) return written;
  return file;
}

export async function removeHaloRpcFile(options: { userDataDir: string }) {
  return await fs
    .rm(rpcFilePath(options.userDataDir), { force: true })
    .catch(
      (cause) =>
        new HaloRpcDiscoveryError({ detail: "remove rpc.json", cause }),
    );
}
