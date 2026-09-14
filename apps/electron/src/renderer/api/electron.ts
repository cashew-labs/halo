import {
  connectHaloRpc,
  type HaloRpcConnectionError,
} from "./connectHaloRpc.js";
import type { DesktopApi } from "../../shared/desktop.js";
import type { ConnectedHaloApi } from "./ApiProvider.js";

export const desktopApi: DesktopApi = window.haloDesktop;

export async function createElectronApi({
  onDisconnect,
}: {
  onDisconnect: (error: HaloRpcConnectionError) => void;
}): Promise<ConnectedHaloApi | Error | undefined> {
  const connection = await desktopApi.getConnection();
  if (connection === undefined) return undefined;
  const api = await connectHaloRpc({
    connection,
    onDisconnect,
  });
  if (api instanceof Error) return api;
  return { api, connection };
}
