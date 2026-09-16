import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { HaloRpcTransport } from "@get-halo/client";
import type { AppControlClient } from "./appControlContract.js";

export function createAppControlClient({
  transport,
}: {
  transport: HaloRpcTransport;
}): AppControlClient {
  const link = new RPCLink({
    origin: transport.origin,
    url: transport.path,
    headers: transport.headers,
  });
  return createORPCClient<AppControlClient>(link, { path: ["app"] });
}
