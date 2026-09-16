import { homedir } from "node:os";
import {
  connectHaloClient,
  IncompatibleServerError,
  type HaloRpcTransport,
} from "@get-halo/client";
import * as errore from "errore";
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
  const transport: HaloRpcTransport = {
    origin: `http://${file.host}:${file.port}`,
    path: "/rpc",
    headers: { authorization: `Bearer ${file.token}` },
  };
  const connected = await connectHaloClient({ transport });
  if (connected instanceof IncompatibleServerError) {
    return new HaloProtocolVersionError({
      clientProtocolVersion: connected.clientProtocolVersion,
      serverProtocolVersion: connected.serverProtocolVersion,
    });
  }
  if (connected instanceof Error) {
    return new HaloRpcFileError({
      detail: "server.info failed",
      cause: connected,
    });
  }
  return { file, transport, ...connected };
}
