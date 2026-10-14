import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { GoogleAuth, type IdTokenClient } from "google-auth-library";
import { createProxyServer, proxyUpgrade } from "httpxy";
import * as errore from "errore";
import type { AuthService } from "../auth/AuthService.js";
import type { WorkspaceService } from "./WorkspaceService.js";
import type { WorkspaceProviderConnection } from "./provider/WorkspaceProviderApi.js";

const workspacePathPrefix = "/workspace";
const workspaceProxy = createProxyServer();

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

/** Server-side credentials for reaching a workspace or app VM. */
export class WorkspaceAuthorization {
  // Reuses Google ID tokens until the auth library refreshes them near expiry.
  private readonly identityClients = new Map<string, IdTokenClient>();
  private readonly googleAuth = new GoogleAuth();

  // coverage-exempt: Moved unchanged from WorkspaceGateway.getAuthorization; header and Google identity providers are Exe and Cloud Run ingress.
  async headers(connection: WorkspaceProviderConnection) {
    if (connection.authorization.type === "headers") {
      return connection.authorization.value;
    }
    if (connection.authorization.type === "bearer") {
      return { authorization: connection.authorization.value };
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
    return { authorization };
  }
}

export class WorkspaceGateway {
  private readonly auth: AuthService;
  private readonly authorization: WorkspaceAuthorization;
  private readonly publicOrigin: URL;
  private readonly workspace: WorkspaceService;

  constructor(ctx: {
    auth: AuthService;
    authorization: WorkspaceAuthorization;
    publicOrigin: string;
    workspace: WorkspaceService;
  }) {
    this.auth = ctx.auth;
    this.authorization = ctx.authorization;
    this.publicOrigin = new URL(ctx.publicOrigin);
    this.workspace = ctx.workspace;
  }

  async serve(request: IncomingMessage, response: ServerResponse) {
    if (request.method === "OPTIONS") {
      respondToPreflight(request, response);
      return;
    }

    const url = new URL(request.url ?? "/", this.publicOrigin);
    if (url.pathname === "/workspace/rpc/connect") {
      if (
        request.headers.origin !== undefined &&
        request.headers.origin !== this.publicOrigin.origin &&
        !(
          request.headers.origin === "null" &&
          request.headers.authorization !== undefined
        )
      ) {
        respond(request, response, 403);
        return;
      }
      const clientId = request.headers["x-halo-client-id"];
      if (
        request.method !== "POST" ||
        !Value.Check(Type.String({ pattern: "^[a-f0-9-]{36}$" }), clientId)
      ) {
        respond(request, response, 400);
        return;
      }
      const ticket = await this.auth.createWorkspaceSocketTicket(
        requestHeaders(request),
        clientId,
      );
      if (ticket instanceof Error) {
        // coverage-exempt: Response to an external auth/database outage; no service mocks in the full gateway fixture.
        console.error(ticket);
        respond(request, response, 500);
        return;
      }
      if (ticket === undefined) {
        respond(request, response, 401);
        return;
      }
      response
        .writeHead(200, {
          ...corsHeaders(request),
          "content-type": "application/json",
          "cache-control": "no-store",
        })
        .end(JSON.stringify(ticket));
      return;
    }

    const session = await this.auth.getSession(requestHeaders(request));
    if (session instanceof Error) {
      console.error(session);
      respond(request, response, 500);
      return;
    }
    if (session === undefined) {
      respond(request, response, 401);
      return;
    }

    const connection = await this.workspace.getConnection(session.user.id);
    if (connection instanceof Error) {
      console.error(connection);
      respond(request, response, 503);
      return;
    }
    if (connection === undefined) {
      respond(request, response, 503);
      return;
    }

    const authorization = await this.authorization.headers(connection);
    if (authorization instanceof Error) {
      console.error(authorization);
      respond(request, response, 502);
      return;
    }

    await forwardWorkspaceRequest({
      request,
      response,
      origin: connection.origin,
      authorization,
      publicOrigin: this.publicOrigin,
    });
  }

  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(request.url ?? "/", this.publicOrigin);
    const rpcSocket = url.pathname === "/workspace/rpc/socket";
    const protocols =
      request.headers["sec-websocket-protocol"]
        ?.split(",")
        .map((value) => value.trim()) ?? [];
    const ticket = protocols
      .find((value) => value.startsWith("halo-ticket."))
      ?.slice("halo-ticket.".length);
    const session = rpcSocket
      ? await this.auth.consumeWorkspaceSocketTicket(ticket ?? "")
      : await this.auth.getSession(requestHeaders(request));
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

    const authorization = await this.authorization.headers(connection);
    if (authorization instanceof Error) {
      console.error(authorization);
      respondToUpgrade(socket, 502);
      return;
    }

    if (socket.destroyed) return;
    const target = workspaceTarget(request, connection.origin);
    prepareWorkspaceRequest(request, target, authorization, this.publicOrigin);
    if (
      rpcSocket &&
      "clientId" in session &&
      Value.Check(Type.String(), session.clientId)
    ) {
      request.headers["sec-websocket-protocol"] = "halo-rpc";
      request.headers["x-halo-client-id"] = session.clientId;
      request.headers["x-halo-session-expires"] = String(
        session.session.expiresAt.getTime(),
      );
    }
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
}

async function forwardWorkspaceRequest(ctx: {
  authorization: Readonly<Record<string, string>>;
  origin: string;
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
  const proxied = await workspaceProxy
    .web(ctx.request, ctx.response, {
      target: target.origin,
      xfwd: false,
    })
    .catch(
      (cause) => new WorkspaceGatewayError({ detail: "proxy request", cause }),
    );
  if (!(proxied instanceof Error)) return;

  console.error(proxied);
  if (!ctx.response.headersSent) respond(ctx.request, ctx.response, 502);
  if (!ctx.response.writableEnded) ctx.response.end();
}

function prepareWorkspaceRequest(
  request: IncomingMessage,
  target: URL,
  authorization: Readonly<Record<string, string>>,
  publicOrigin: URL,
) {
  delete request.headers["x-halo-viewer-id"];
  delete request.headers["x-halo-viewer-role"];
  delete request.headers["x-halo-viewer-email"];
  delete request.headers["x-halo-extension-token"];
  delete request.headers["x-halo-viewer-token"];
  delete request.headers["x-halo-client-id"];
  delete request.headers["x-halo-session-expires"];
  delete request.headers.authorization;
  delete request.headers.cookie;
  delete request.headers.forwarded;
  delete request.headers["x-forwarded-host"];
  delete request.headers["x-forwarded-proto"];
  delete request.headers["x-halo-public-host"];
  delete request.headers["x-halo-public-proto"];
  delete request.headers["x-exedev-authorization"];
  delete request.headers["x-exedev-token-ctx"];
  delete request.headers["x-exedev-userid"];
  delete request.headers["x-exedev-email"];
  for (const [name, value] of Object.entries(authorization)) {
    request.headers[name.toLowerCase()] = value;
  }
  // Private provider ingress routes by Host; Halo uses the forwarded public origin.
  request.headers.host = target.host;
  request.headers["x-forwarded-host"] = publicOrigin.host;
  request.headers["x-forwarded-proto"] = publicOrigin.protocol.slice(0, -1);
  // Provider proxies rewrite X-Forwarded-*; preserve Halo's origin separately.
  request.headers["x-halo-public-host"] = publicOrigin.host;
  request.headers["x-halo-public-proto"] = publicOrigin.protocol.slice(0, -1);
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
) {
  response
    .writeHead(204, {
      ...corsHeaders(request),
      "access-control-allow-headers":
        "authorization, content-type, x-halo-protocol-version, x-halo-client-id",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-max-age": "3600",
    })
    .end();
}

function respond(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
) {
  response.writeHead(statusCode, corsHeaders(request)).end();
}

function corsHeaders(request: IncomingMessage) {
  if (request.headers.origin !== "null") return {};
  return { "access-control-allow-origin": "null" };
}

function respondToUpgrade(socket: Duplex, statusCode: number) {
  socket.end(
    `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode]}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n",
  );
}
