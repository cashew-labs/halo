import { createORPCClient, onError, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import * as errore from "errore";
import { checkServerCompatibility, protocolHeader } from "./protocol.js";
export { IncompatibleServerError } from "./protocol.js";
import { haloProtocolVersion, type HaloClient } from "./contract.js";

export type HaloRpcTransport = {
  origin: string;
  path: `/${string}`;
  headers: Record<string, string>;
};

export class HaloRpcConnectionError extends errore.createTaggedError({
  name: "HaloRpcConnectionError",
  message: "Halo could not connect to its server.",
}) {}

type HaloClientOptions = {
  transport: HaloRpcTransport;
  onDisconnect?: (error: Error) => void;
  signal?: AbortSignal;
};

export function createHaloClient({
  transport,
  onDisconnect,
}: HaloClientOptions): HaloClient {
  const reportDisconnect = (cause: unknown) => {
    if (onDisconnect === undefined) return;
    if (errore.isAbortError(cause)) return;
    if (
      cause instanceof ORPCError &&
      cause.code !== "MALFORMED_ORPC_RESPONSE"
    ) {
      return;
    }
    onDisconnect(new HaloRpcConnectionError({ cause }));
  };
  const link = new RPCLink({
    origin: transport.origin,
    url: transport.path,
    headers: {
      [protocolHeader]: String(haloProtocolVersion),
      ...transport.headers,
    },
  });
  // SAFETY: The host configures this transport for the Halo router.
  return createORPCClient(link, {
    interceptors: [onError(reportDisconnect)],
  }) as HaloClient;
}

export async function connectHaloClient(options: HaloClientOptions) {
  const client = createHaloClient(options);
  const info = await client.server
    .info(undefined, { signal: options.signal })
    .catch((cause) => new HaloRpcConnectionError({ cause }));
  if (info instanceof Error) return info;
  const compatibility = checkServerCompatibility({
    info,
    service: "workspace",
    clientProtocolVersion: haloProtocolVersion,
  });
  if (compatibility instanceof Error) return compatibility;
  return { client, serverInfo: info };
}
