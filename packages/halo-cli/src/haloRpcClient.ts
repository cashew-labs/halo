import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { HaloClient } from "@get-halo/shared/contract";
import type { HaloRpcFile } from "./HaloRpcFile.js";

export function createHaloRpcClient<T = HaloClient>(file: HaloRpcFile): T {
  const link = new RPCLink({
    origin: `http://${file.host}:${file.port}`,
    url: "/rpc",
    headers: { authorization: `Bearer ${file.token}` },
  });
  // SAFETY: the caller supplies the Halo contract client type.
  return createORPCClient(link) as T;
}
