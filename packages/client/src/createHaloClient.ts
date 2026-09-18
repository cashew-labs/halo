import { createORPCClient, onError, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import * as errore from "errore";
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

export class IncompatibleServerError extends errore.createTaggedError({
  name: "IncompatibleServerError",
  message:
    "Halo protocol $clientProtocolVersion cannot use server protocol $serverProtocolVersion.",
}) {}

type HaloClientOptions = {
  transport: HaloRpcTransport;
  onDisconnect?: (error: Error) => void;
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
    headers: transport.headers,
  });
  // SAFETY: The host configures this transport for the Halo router.
  return createORPCClient(link, {
    interceptors: [onError(reportDisconnect)],
  }) as HaloClient;
}

export async function connectHaloClient(options: HaloClientOptions) {
  const client = createHaloClient(options);
  const info = await client.server
    .info()
    .catch((cause) => new HaloRpcConnectionError({ cause }));
  if (info instanceof Error) return info;
  if (info.protocolVersion !== haloProtocolVersion) {
    return new IncompatibleServerError({
      clientProtocolVersion: haloProtocolVersion,
      serverProtocolVersion: info.protocolVersion,
    });
  }
  return { client, serverInfo: info };
}
