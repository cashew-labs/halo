import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { GoogleAuth, type IdTokenClient } from "google-auth-library";
import * as errore from "errore";
import type { AuthService } from "../auth/AuthService.js";
import type {
  WorkspaceConnection,
  WorkspaceService,
} from "./WorkspaceService.js";

const workspacePathPrefix = "/workspace";
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

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

  private readonly auth: AuthService;
  private readonly googleAuth: GoogleAuth;
  private readonly workspace: WorkspaceService;

  constructor(ctx: { auth: AuthService; workspace: WorkspaceService }) {
    this.auth = ctx.auth;
    this.googleAuth = new GoogleAuth();
    this.workspace = ctx.workspace;
  }

  async serve(request: IncomingMessage, response: ServerResponse) {
    if (request.method === "OPTIONS") {
      respondToPreflight(request, response);
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

    const authorization = await this.getAuthorization(connection);
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
    });
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
  origin: string;
  request: IncomingMessage;
  response: ServerResponse;
}) {
  const incomingUrl = new URL(
    ctx.request.url === undefined ? "/" : ctx.request.url,
    "http://localhost",
  );
  const workspacePath = incomingUrl.pathname.slice(workspacePathPrefix.length);
  const target = new URL(
    `${workspacePath === "" ? "/" : workspacePath}${incomingUrl.search}`,
    ctx.origin,
  );

  return await new Promise<void>((resolve) => {
    const upstreamRequest = http.request(
      target,
      {
        method: ctx.request.method,
        headers: forwardedRequestHeaders(
          ctx.request.headers,
          target.host,
          ctx.authorization,
        ),
      },
      (upstreamResponse) => {
        const statusCode =
          upstreamResponse.statusCode === undefined
            ? 502
            : upstreamResponse.statusCode;
        ctx.response.writeHead(
          statusCode,
          forwardedHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(ctx.response);
        ctx.response.once("finish", resolve);
        ctx.response.once("close", () => {
          upstreamResponse.destroy();
          resolve();
        });
      },
    );

    upstreamRequest.once("error", (cause) => {
      console.error("Workspace gateway request failed", cause);
      if (!ctx.response.headersSent) respond(ctx.request, ctx.response, 502);
      if (!ctx.response.writableEnded) ctx.response.end();
      resolve();
    });
    ctx.request.once("aborted", () => {
      upstreamRequest.destroy();
      resolve();
    });
    ctx.request.pipe(upstreamRequest);
  });
}

function forwardedRequestHeaders(
  incoming: IncomingHttpHeaders,
  host: string,
  authorization: string,
) {
  const headers = forwardedHeaders(incoming);
  delete headers.authorization;
  delete headers.cookie;
  headers.authorization = authorization;
  headers.host = host;
  return headers;
}

function forwardedHeaders(incoming: IncomingHttpHeaders) {
  const headers: OutgoingHttpHeaders = {};

  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || hopByHopHeaders.has(name.toLowerCase()))
      continue;
    headers[name] = value;
  }

  return headers;
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
) {
  response.writeHead(statusCode, corsHeaders(request)).end();
}

function corsHeaders(request: IncomingMessage) {
  if (request.headers.origin !== "null") return {};
  return { "access-control-allow-origin": "null" };
}
