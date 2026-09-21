import {
  acceptsProtocol,
  protocolHeader,
  haloProtocolVersion,
  haloSupportedProtocols,
} from "@get-halo/client";
import { ORPCError } from "@orpc/server";
import crypto from "node:crypto";
import nodeHttp, {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { RPCHandler, type RPCHandlerOptions } from "@orpc/server/node";
import {
  CORSHandlerPlugin,
  RequestHeadersHandlerPlugin,
} from "@orpc/server/plugins";
import { anyAbortSignal } from "@orpc/shared";
import { OAuth2Client } from "google-auth-library";
import * as errore from "errore";
import { handleOAuthCallback } from "./oauth.js";
import { haloRpcRouter, type HaloContext } from "./router.js";
import { extensionToolRouter } from "../extensions/extensionsRouter.js";
import {
  isExtensionProxyRequest,
  serveExtensionRequest,
  serveExtensionUpgrade,
} from "../extensions/extensionProxy.js";

const localConnectionHost = "127.0.0.1";

type HaloHttpConnection = {
  host: string;
  port: number;
  token: string;
};

type HaloHttpConnections = {
  cli: HaloHttpConnection;
  renderer: HaloHttpConnection;
};

export type WorkspaceGatewayIdentity = {
  audience: string;
  serviceAccountEmail: string;
};

export type ListeningHaloHttp = {
  connections: HaloHttpConnections;
  server: HttpServer;
  origin: string;
};

export type ServingHaloHttp = {
  close: () => Promise<void>;
};

export class HaloHttpError extends errore.createTaggedError({
  name: "HaloHttpError",
  message: "Halo HTTP server failed: $detail",
}) {}

class HaloRequestsClosedError extends errore.createTaggedError({
  name: "HaloRequestsClosedError",
  message: "Halo is shutting down.",
  extends: errore.AbortError,
}) {}

class WorkspaceGatewayAuthenticationError extends errore.createTaggedError({
  name: "WorkspaceGatewayAuthenticationError",
  message: "Workspace gateway authentication failed",
}) {}

export async function listenHaloHttp(options: {
  host: string;
  port: number;
}): Promise<ListeningHaloHttp | HaloHttpError> {
  const server = createServer(startingResponse);
  const started = await listen(server, options);
  if (started instanceof Error) return started;
  // SAFETY: Node returns a TCP address after successfully listening with a numeric port.
  const address = server.address() as AddressInfo;
  return {
    server,
    origin: `http://${localConnectionHost}:${address.port}`,
    connections: {
      cli: {
        host: localConnectionHost,
        port: address.port,
        token: crypto.randomBytes(32).toString("base64url"),
      },
      renderer: {
        host: localConnectionHost,
        port: address.port,
        token: crypto.randomBytes(32).toString("base64url"),
      },
    },
  };
}

function startingResponse(_request: IncomingMessage, response: ServerResponse) {
  response.writeHead(503).end("Halo is starting.");
}

export function serveHaloHttp(options: {
  server: HttpServer;
  connections: HaloHttpConnections;
  context: HaloContext;
  corsOrigins: readonly string[];
  gateway?: WorkspaceGatewayIdentity;
}): ServingHaloHttp {
  const shutdown = new AbortController();
  const pendingRequests = new Set<Promise<void>>();
  const pendingUpgrades = new Set<Promise<void>>();
  const upgradeSockets = new Set<Duplex>();
  const cliToken = options.connections.cli.token;
  const rendererToken = options.connections.renderer.token;
  const identityVerifier = new OAuth2Client();
  const interceptors: RPCHandlerOptions<object>["interceptors"] = [
    async ({ next, ...call }) =>
      await next({
        ...call,
        request: {
          ...call.request,
          signal: anyAbortSignal([call.request.signal, shutdown.signal]),
        },
      }),
  ];
  const handler = new RPCHandler<HaloContext>(haloRpcRouter, {
    interceptors,
    clientInterceptors: [
      ({ path, context, next }) => {
        if (
          path.join(".") !== "server.info" &&
          !acceptsProtocol({
            selected: context.reqHeaders?.get(protocolHeader) ?? undefined,
            supported: haloSupportedProtocols,
            legacy: haloProtocolVersion,
          })
        )
          throw new ORPCError("UNSUPPORTED_PROTOCOL", {
            data: { supportedProtocols: haloSupportedProtocols },
          });
        return next();
      },
    ],
    plugins: [
      new RequestHeadersHandlerPlugin(),
      new CORSHandlerPlugin({
        origin: options.corsOrigins,
        allowHeaders: ["authorization", "content-type", protocolHeader],
      }),
    ],
  });
  const extensionHandler = new RPCHandler(extensionToolRouter, {
    interceptors,
  });
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    const url = new URL(
      request.url === undefined ? "/" : request.url,
      "http://localhost",
    );
    if (url.pathname === "/oauth/callback") {
      await handleOAuthCallback({
        url,
        request,
        response,
        context: options.context,
      });
      return;
    }
    if (url.pathname.startsWith("/extension-tools/")) {
      const extensionId = options.context.extensions.identifyToolConnection(
        request.headers.authorization,
      );
      if (extensionId === undefined) {
        response.writeHead(401).end();
        return;
      }
      const handled = await extensionHandler.handle(request, response, {
        prefix: "/extension-tools",
        context: {
          toolRuntime: options.context.toolRuntime,
        },
      });
      if (!handled.matched) response.writeHead(404).end();
      return;
    }
    const authorization =
      request.method === "OPTIONS"
        ? undefined
        : await authorizeWorkspaceRequest({
            authorization: request.headers.authorization,
            cliToken,
            rendererToken,
            gateway: options.gateway,
            identityVerifier,
          });
    if (authorization instanceof Error) {
      options.context.logger.warn({
        event: "workspace-gateway-authentication-failed",
        error: authorization,
      });
      response.statusCode = 401;
      response.end();
      return;
    }
    if (request.method !== "OPTIONS" && authorization === undefined) {
      response.statusCode = 401;
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200).end();
      return;
    }

    if (isExtensionProxyRequest(url)) {
      await serveExtensionRequest({
        extensions: options.context.extensions,
        request,
        response,
        url,
      });
      return;
    }

    const handled = await handler.handle(request, response, {
      prefix: "/rpc",
      context: {
        ...options.context,
        browserControlAllowed: authorization === "cli",
      },
    });
    if (handled.matched) return;
    response.statusCode = 404;
    response.end();
  };
  options.server.removeListener("request", startingResponse);
  options.server.on("request", async (request, response) => {
    if (shutdown.signal.aborted) {
      response.writeHead(503).end("Halo is shutting down.");
      return;
    }
    const pending = handleRequest(request, response);
    pendingRequests.add(pending);
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => pendingRequests.delete(pending));
    await pending;
  });
  const handleUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    if (shutdown.signal.aborted) {
      respondToUpgrade(socket, 503);
      return;
    }
    const authorization = await authorizeWorkspaceRequest({
      authorization: request.headers.authorization,
      cliToken,
      rendererToken,
      gateway: options.gateway,
      identityVerifier,
    });
    if (authorization instanceof Error) {
      options.context.logger.warn({
        event: "workspace-gateway-authentication-failed",
        error: authorization,
      });
      respondToUpgrade(socket, 401);
      return;
    }
    if (authorization === undefined) {
      respondToUpgrade(socket, 401);
      return;
    }
    const url = new URL(
      request.url === undefined ? "/" : request.url,
      "http://localhost",
    );
    if (!isExtensionProxyRequest(url)) {
      respondToUpgrade(socket, 404);
      return;
    }
    await serveExtensionUpgrade({
      extensions: options.context.extensions,
      request,
      socket,
      head,
      url,
    });
  };
  options.server.on("upgrade", async (request, socket, head) => {
    upgradeSockets.add(socket);
    socket.once("close", () => upgradeSockets.delete(socket));
    const pending = handleUpgrade(request, socket, head);
    pendingUpgrades.add(pending);
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => pendingUpgrades.delete(pending));
    await pending;
  });
  return {
    async close() {
      shutdown.abort(new HaloRequestsClosedError());
      for (const socket of upgradeSockets) socket.destroy();
      await Promise.all([...pendingRequests, ...pendingUpgrades]);
    },
  };
}

async function authorizeWorkspaceRequest(ctx: {
  authorization: string | undefined;
  cliToken: string;
  gateway: WorkspaceGatewayIdentity | undefined;
  identityVerifier: OAuth2Client;
  rendererToken: string;
}) {
  if (ctx.authorization === `Bearer ${ctx.cliToken}`) return "cli" as const;
  if (ctx.authorization === `Bearer ${ctx.rendererToken}`)
    return "renderer" as const;
  if (ctx.authorization === undefined || ctx.gateway === undefined)
    return undefined;
  if (!ctx.authorization.startsWith("Bearer ")) return undefined;

  const ticket = await ctx.identityVerifier
    .verifyIdToken({
      idToken: ctx.authorization.slice("Bearer ".length),
      audience: ctx.gateway.audience,
    })
    .catch((cause) => new WorkspaceGatewayAuthenticationError({ cause }));
  if (ticket instanceof Error) return ticket;

  const payload = ticket.getPayload();
  if (
    payload?.email !== ctx.gateway.serviceAccountEmail ||
    payload.email_verified !== true
  ) {
    return undefined;
  }

  return "gateway" as const;
}

export async function closeHaloHttp(http: ListeningHaloHttp) {
  const { server } = http;
  const closing = new Promise<undefined | HaloHttpError>((resolve) => {
    server.close((error) => {
      if (error !== undefined) {
        resolve(new HaloHttpError({ detail: "close failed", cause: error }));
        return;
      }
      resolve(undefined);
    });
  });
  server.closeAllConnections();
  return await closing;
}

async function listen(
  server: HttpServer,
  options: { host: string; port: number },
) {
  return await new Promise<undefined | HaloHttpError>((resolve) => {
    server.once("error", (error) => {
      resolve(new HaloHttpError({ detail: "listen failed", cause: error }));
    });
    server.listen(options.port, options.host, () => resolve(undefined));
  });
}

function respondToUpgrade(socket: Duplex, statusCode: number) {
  socket.end(
    `HTTP/1.1 ${statusCode} ${nodeHttp.STATUS_CODES[statusCode]}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n",
  );
}
