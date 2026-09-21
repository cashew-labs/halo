import { homedir } from "node:os";
import { connectHaloClient, IncompatibleServerError } from "@get-halo/client";
import * as errore from "errore";
import { findHaloRpcFile } from "./findHaloRpcFile.js";
import { HaloRpcFileError } from "@get-halo/shared/HaloRpcFile";

export type HaloRpcEnv = {
  HALO_RPC_FILE?: string;
  HALO_USER_DATA?: string;
};

export class HaloProtocolVersionError extends errore.createTaggedError({
  name: "HaloProtocolVersionError",
  message:
    "This Halo CLI uses protocol $clientProtocolVersion; the server supports protocols $supportedProtocols.",
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
  const connected = await connectHaloClient({
    transport: {
      origin: `http://${file.host}:${file.port}`,
      path: "/rpc",
      headers: { authorization: `Bearer ${file.token}` },
    },
  });
  if (connected instanceof IncompatibleServerError) {
    return new HaloProtocolVersionError({
      clientProtocolVersion: connected.clientProtocolVersion,
      supportedProtocols: connected.supportedProtocols.join(", "),
    });
  }
  if (connected instanceof Error) {
    return new HaloRpcFileError({
      detail: "server.info failed",
      cause: connected,
    });
  }
  return { file, ...connected };
}
