import { homedir } from "node:os";
import {
  haloProtocolVersion,
  type HaloClient,
} from "@get-halo/shared/contract";
import * as errore from "errore";
import { createHaloRpcClient } from "./haloRpcClient.js";
import { findHaloRpcFile } from "./findHaloRpcFile.js";
import { HaloRpcFileError } from "./HaloRpcFile.js";

export type HaloRpcEnv = {
  HALO_RPC_FILE?: string;
  HALO_USER_DATA?: string;
};

export class HaloProtocolVersionError extends errore.createTaggedError({
  name: "HaloProtocolVersionError",
  message:
    "This Halo CLI uses protocol $clientProtocolVersion; the server uses protocol $serverProtocolVersion.",
}) {}

export function cliVersion() {
  return process.env.HALO_VERSION;
}

export async function connectHalo(env: HaloRpcEnv) {
  const file = await findHaloRpcFile({
    rpcFile: env.HALO_RPC_FILE,
    userDataDir: env.HALO_USER_DATA,
    cwd: process.cwd(),
    homeDir: homedir(),
    platform: process.platform,
    appData: process.env.APPDATA,
  });
  if (file instanceof Error) return file;
  const client = createHaloRpcClient<HaloClient>(file);
  const info = await client.server
    .info()
    .catch(
      (e) => new HaloRpcFileError({ detail: "server.info failed", cause: e }),
    );
  if (info instanceof Error) return info;
  if (info.protocolVersion !== haloProtocolVersion) {
    return new HaloProtocolVersionError({
      clientProtocolVersion: haloProtocolVersion,
      serverProtocolVersion: info.protocolVersion,
    });
  }
  return { file, client, serverInfo: info };
}
