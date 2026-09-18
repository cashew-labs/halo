import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AppControlClient } from "./appControlContract.js";
import type { AppControlConnection } from "./AppControlConnection.js";

export function createAppControlClient({
  connection,
}: {
  connection: AppControlConnection;
}): AppControlClient {
  const link = new RPCLink({
    origin: `http://127.0.0.1:${connection.port}`,
    url: "/rpc",
    headers: { authorization: `Bearer ${connection.token}` },
  });
  return createORPCClient<AppControlClient>(link);
}
