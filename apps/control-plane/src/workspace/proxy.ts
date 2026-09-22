import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { GoogleAuth, type IdTokenClient } from "google-auth-library";
import { createProxyServer, proxyUpgrade } from "httpxy";
import * as errore from "errore";
import type { AuthService } from "../auth/AuthService.js";
import type {
  WorkspaceConnection,
  WorkspaceService,
} from "./WorkspaceService.js";

const workspacePathPrefix = "/workspace";

class WorkspaceGatewayError extends errore.createTaggedError({
  name: "WorkspaceGatewayError",
  message: "Workspace gateway failed: $detail",
}) {}

export function isWorkspaceProxyRequest(url: URL) {
  return (
    url.pathname === workspacePathPrefix ||
    url.pathname.startsWith(`${workspacePathPrefix}/`)
  );
}

export class WorkspaceGateway {
  // Reuses Google ID tokens until the auth library refreshes them near expiry.
  private readonly identityClients = new Map<string, IdTokenClient>();
  private readonly proxy = createProxyServer();

  private readonly auth: AuthService;
  private readonly corsOrigins: readonly string[];
  private readonly googleAuth: GoogleAuth;
  private readonly publicOrigin: URL;
  private readonly workspace: WorkspaceService;

  constructor(ctx: {
    auth: AuthService;
    corsOrigins: readonly string[];
    publicOrigin: string;
    workspace: WorkspaceService;
  }) {
    this.auth = ctx.auth;
    this.corsOrigins = ctx.corsOrigins;
    this.googleAuth = new GoogleAuth();
    this.publicOrigin = new URL(ctx.publicOrigin);
    this.workspace = ctx.workspace;
    this.proxy.on("proxyRes", (proxyRes, request) => {
      Object.assign(proxyRes.headers, corsHeaders(request, this.corsOrigins));
    });
  }

  async serve(request: IncomingMessage, response: ServerResponse) {
    if (request.method === "OPTIONS") {
      respondToPreflight(request, response, this.corsOrigins);
      return;
    }

    const session = await this.auth.getSession(requestHeaders(request));
    if (session instanceof Error) {
      console.error(session);
      respond(request, response, 500, this.corsOrigins);
      return;
    }
    if (session === undefined) {
      respond(request, response, 401, this.corsOrigins);
      return;
    }

    const connection = await this.workspace.getConnection(session.user.id);
    if (connection instanceof Error) {
      console.error(connection);
      respond(request, response, 503, this.corsOrigins);
      return;
    }
    if (connection === undefined) {
      respond(request, response, 503, this.corsOrigins);
      return;
    }

    const authorization = await this.getAuthorization(connection);
    if (authorization instanceof Error) {
      console.error(authorization);
      respond(request, response, 502, this.corsOrigins);
      return;
    }

    await forwardWorkspaceRequest({
      request,
      response,
      origin: connection.origin,
      authorization,
      corsOrigins: this.corsOrigins,
      proxy: this.proxy,
      publicOrigin: this.publicOrigin,
    });
  }

  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const session = await this.auth.getSession(requestHeaders(request));
    if (session instanceof Error) {
      console.error(session);
      respondToUpgrade(socket, 500);
      return;
    }
    if (session === undefined) {
      respondToUpgrade(socket, 401);
      return;
    }

    const connection = await this.workspace.getConnection(session.user.id);
    if (connection instanceof Error) {
      console.error(connection);
      respondToUpgrade(socket, 503);
      return;
    }
    if (connection === undefined) {
      respondToUpgrade(socket, 503);
      return;
    }

    const authorization = await this.getAuthorization(connection);
    if (authorization instanceof Error) {
      console.error(authorization);
      respondToUpgrade(socket, 502);
      return;
    }

    const target = workspaceTarget(request, connection.origin);
    prepareWorkspaceRequest(request, target, authorization, this.publicOrigin);
    const proxied = await proxyUpgrade(target.origin, request, socket, head, {
      xfwd: false,
    }).catch(
      (cause) =>
        new WorkspaceGatewayError({
          detail: "proxy WebSocket upgrade",
          cause,
        }),
    );
    if (proxied instanceof Error) console.error(proxied);
  }

  private async getAuthorization(connection: WorkspaceConnection) {
    if (connection.authorization.type === "bearer") {
      return connection.authorization.value;
    }

    const audience = connection.origin;
    const cached = this.identityClients.get(audience);
    const client =
      cached === undefined
        ? await this.googleAuth.getIdTokenClient(audience).catch(
            (cause) =>
              new WorkspaceGatewayError({
                detail: "create identity client",
                cause,
              }),
          )
        : cached;
    if (client instanceof Error) return client;

    this.identityClients.set(audience, client);
    const headers = await client
      .getRequestHeaders()
      .catch(
        (cause) =>
          new WorkspaceGatewayError({ detail: "get identity token", cause }),
      );
    if (headers instanceof Error) return headers;

    const authorization = headers.get("authorization");
    if (authorization === null) {
      return new WorkspaceGatewayError({
        detail: "identity token response has no authorization header",
      });
    }

    return authorization;
  }
}

async function forwardWorkspaceRequest(ctx: {
  authorization: string;
  corsOrigins: readonly string[];
  origin: string;
  proxy: ReturnType<typeof createProxyServer>;
  publicOrigin: URL;
  request: IncomingMessage;
  response: ServerResponse;
}) {
  const target = workspaceTarget(ctx.request, ctx.origin);
  prepareWorkspaceRequest(
    ctx.request,
    target,
    ctx.authorization,
    ctx.publicOrigin,
  );
  const proxied = await ctx.proxy
    .web(ctx.request, ctx.response, {
      target: target.origin,
      xfwd: false,
    })
    .catch(
      (cause) => new WorkspaceGatewayError({ detail: "proxy request", cause }),
    );
  if (!(proxied instanceof Error)) return;

  console.error(proxied);
  if (!ctx.response.headersSent)
    respond(ctx.request, ctx.response, 502, ctx.corsOrigins);
  if (!ctx.response.writableEnded) ctx.response.end();
}

function prepareWorkspaceRequest(
  request: IncomingMessage,
  target: URL,
  authorization: string,
  publicOrigin: URL,
) {
  delete request.headers.authorization;
  delete request.headers.cookie;
  delete request.headers.forwarded;
  delete request.headers["x-forwarded-host"];
  delete request.headers["x-forwarded-proto"];
  request.headers.authorization = authorization;
  request.headers.host = publicOrigin.host;
  request.headers["x-forwarded-host"] = publicOrigin.host;
  request.headers["x-forwarded-proto"] = publicOrigin.protocol.slice(0, -1);
  request.url = `${target.pathname}${target.search}`;
}

function workspaceTarget(request: IncomingMessage, origin: string) {
  const incomingUrl = new URL(
    request.url === undefined ? "/" : request.url,
    "http://localhost",
  );
  const workspacePath = incomingUrl.pathname.slice(workspacePathPrefix.length);
  return new URL(
    `${workspacePath === "" ? "/" : workspacePath}${incomingUrl.search}`,
    origin,
  );
}

function requestHeaders(request: IncomingMessage) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
      continue;
    }

    headers.set(name, value);
  }

  return headers;
}

function respondToPreflight(
  request: IncomingMessage,
  response: ServerResponse,
  corsOrigins: readonly string[],
) {
  response
    .writeHead(204, {
      ...corsHeaders(request, corsOrigins),
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-max-age": "3600",
    })
    .end();
}

function respond(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  corsOrigins: readonly string[],
) {
  response.writeHead(statusCode, corsHeaders(request, corsOrigins)).end();
}

function corsHeaders(request: IncomingMessage, corsOrigins: readonly string[]) {
  const origin = request.headers.origin;
  if (origin === undefined) return {};
  if (!corsOrigins.includes(origin)) return {};
  return { "access-control-allow-origin": origin };
}

function respondToUpgrade(socket: Duplex, statusCode: number) {
  socket.end(
    `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode]}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n",
  );
}
