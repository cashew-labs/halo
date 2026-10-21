import {
  AuthenticationRequiredError,
  ConnectionUnavailableError,
  ConnectionHttpError,
} from "./connectionErrors.js";
import {
  type ClientLink,
  type ClientContext,
  createORPCClient,
  onError,
  ORPCError,
} from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCLink as SocketRPCLink } from "@orpc/client/websocket";
import { HaloSocket } from "./HaloSocket.js";
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
  websocket?: { clientId: string; signal: AbortSignal };
};

export function createHaloClient({
  transport,
  onDisconnect,
  signal,
  canRequest,
  websocket,
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
  const socket =
    websocket === undefined
      ? undefined
      : new HaloSocket({ ...websocket, transport, onDisconnect }); // coverage-exempt: Playwright Node source-map artifact; client.spec.ts and webHost.e2e.test.ts construct real socket clients.
  const httpLink = new RPCLink({
    origin: transport.origin,
    url: transport.path,
    fetch: async (url, init, _options, path) => {
      if (canRequest !== undefined && !canRequest(path))
        throw new ConnectionUnavailableError();
      const signals = [init.signal, signal, websocket?.signal].filter(
        (value): value is AbortSignal => value !== undefined && value !== null,
      );
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any(signals),
      });
      if (response.status === 401) throw new AuthenticationRequiredError();
      if ([502, 503, 504].includes(response.status))
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
  const socketLink =
    socket === undefined
      ? undefined
      : new SocketRPCLink({
          connect: async () => await socket.connect(),
          // Halo owns one retry loop. Never replay mutations after a lost connection.
          reconnect: { enabled: false },
          headers: { [protocolHeader]: String(haloProtocolVersion) },
          interceptors: [
            async ({ next, ...call }) => {
              if (canRequest !== undefined && !canRequest(call.path))
                throw new ConnectionUnavailableError();
              return await next({
                ...call, // coverage-exempt: Playwright Node source-map artifact on an object spread; real RPC calls in client.spec.ts and webHost.e2e.test.ts execute this interceptor.
                signal: AbortSignal.any([
                  ...(websocket === undefined ? [] : [websocket.signal]),
                  ...(signal === undefined ? [] : [signal]),
                  ...(call.signal === undefined ? [] : [call.signal]),
                ]),
              });
            },
          ],
        });
  const link = {
    call: async (path, input, options) => {
      // File bodies can exceed frame limits; HTTP also supports multipart uploads.
      // Chat submissions are finite HTTP requests; chat updates use the shared socket.
      const selected =
        socketLink === undefined || httpTransferMethods.has(path.join("."))
          ? httpLink
          : socketLink; // coverage-exempt: Playwright Node source-map artifact on a ternary arm; client.spec.ts and the silent-loss E2E execute this socket path.
      return await selected.call(path, input, options);
    },
  } satisfies ClientLink<ClientContext>;
  // SAFETY: The host configures this transport for the Halo router.
  return createORPCClient(link, {
    interceptors: [onError(reportDisconnect)],
  }) as HaloClient;
}

export async function connectHaloClient(options: HaloClientOptions) {
  const client = createHaloClient(options);
  // Probe compatibility before requiring the socket endpoint, so older protocols
  // can still produce the existing server-update message.
  const probe =
    options.websocket === undefined
      ? client
      : createHaloClient({ ...options, websocket: undefined });
  const info = await probe.server
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

const httpTransferMethods = new Set([
  "thread.prompt",
  "uploads.write",
  "workspace.uploadFile",
  "workspace.saveImage",
  "workspace.previewFile",
  "workspace.readFile",
  "workspace.writeFile",
  "workspace.reconcileNote",
]);
