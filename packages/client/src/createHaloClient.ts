import {
  AuthenticationRequiredError,
  ConnectionUnavailableError,
  ConnectionHttpError,
} from "./connectionErrors.js";
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
  canRequest?: (path: string[]) => boolean;
};

export function createHaloClient({
  transport,
  onDisconnect,
  signal,
  canRequest,
}: HaloClientOptions): HaloClient {
  const reportDisconnect = (cause: unknown) => {
    if (onDisconnect === undefined) return;
    if (
      errore.isAbortError(cause) ||
      cause instanceof ConnectionUnavailableError
    )
      return;
    if (
      cause instanceof ORPCError &&
      ![
        "MALFORMED_ORPC_RESPONSE",
        "UNAUTHORIZED",
        "UNSUPPORTED_PROTOCOL",
      ].includes(cause.code)
    ) {
      return;
    }
    onDisconnect(
      cause instanceof ORPCError && cause.code === "UNAUTHORIZED"
        ? new AuthenticationRequiredError({ cause })
        : cause instanceof Error
          ? cause
          : new HaloRpcConnectionError({ cause }),
    );
  };
  const link = new RPCLink({
    origin: transport.origin,
    url: transport.path,
    fetch: async (url, init, _options, path) => {
      if (canRequest !== undefined && !canRequest(path))
        throw new ConnectionUnavailableError();
      const signals = [init.signal, signal].filter(
        (value): value is AbortSignal => value !== undefined && value !== null,
      );
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any(signals),
      });
      if (response.status === 401) throw new AuthenticationRequiredError();
      if (
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504
      )
        throw new ConnectionHttpError({
          service: "workspace",
          stage: "rpc",
          status: response.status,
        });
      return response;
    },
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
