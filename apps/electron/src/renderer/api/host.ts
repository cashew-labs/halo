import {
  connectHaloRpc,
  type HaloRpcConnectionError,
} from "./connectHaloRpc.js";
import type { HostApi } from "../../shared/desktop.js";
import type { ConnectedHaloApi } from "./ApiProvider.js";
import { createWebHost } from "./web.js";

export const hostApi: HostApi =
  window.haloHost === undefined ? createWebHost() : window.haloHost;

export async function createHaloApi({
  onDisconnect,
}: {
  onDisconnect: (error: HaloRpcConnectionError) => void;
}): Promise<ConnectedHaloApi | Error | undefined> {
  const connection = await hostApi.getConnection();
  if (connection === undefined) return undefined;
  const api = await connectHaloRpc({
    connection,
    onDisconnect,
  });
  if (api instanceof Error) return api;
  return { api, connection };
}
