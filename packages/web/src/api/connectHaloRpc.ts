import { createORPCClient, onError, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import * as errore from "errore";
import {
  haloProtocolVersion,
  type HaloClient,
} from "@get-halo/shared/contract";

type HaloRpcTransport = {
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

export async function connectHaloRpc({
  transport,
  onDisconnect,
}: {
  transport: HaloRpcTransport;
  onDisconnect: (error: Error) => void;
}): Promise<Error | HaloClient> {
  const reportDisconnect = (cause: unknown) => {
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
  const client = createORPCClient(link, {
    interceptors: [onError(reportDisconnect)],
  }) as HaloClient;
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
  return client;
}
