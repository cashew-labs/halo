import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { Logger } from "@get-halo/logger";
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
  private readonly corsOrigins: readonly string[];
  private readonly googleAuth: GoogleAuth;
  private readonly logger: Logger;
  private readonly workspace: WorkspaceService;

  constructor(ctx: {
    auth: AuthService;
    corsOrigins: readonly string[];
    logger: Logger;
    workspace: WorkspaceService;
  }) {
    this.auth = ctx.auth;
    this.corsOrigins = ctx.corsOrigins;
    this.googleAuth = new GoogleAuth();
    this.logger = ctx.logger;
    this.workspace = ctx.workspace;
  }

  async serve(request: IncomingMessage, response: ServerResponse) {
    if (request.method === "OPTIONS") {
      respondToPreflight(request, response, this.corsOrigins);
      return;
    }

    const session = await this.auth.getSession(requestHeaders(request));
    if (session instanceof Error) {
      this.logger.error({ event: "workspace-session-failed", error: session });
      respond(request, response, 500, this.corsOrigins);
      return;
    }
    if (session === undefined) {
      respond(request, response, 401, this.corsOrigins);
      return;
    }

    const connection = await this.workspace.getConnection(session.user.id);
    if (connection instanceof Error) {
      this.logger.error({
        event: "workspace-connection-failed",
        error: connection,
      });
      respond(request, response, 503, this.corsOrigins);
      return;
    }
    if (connection === undefined) {
      respond(request, response, 503, this.corsOrigins);
      return;
    }

    const authorization = await this.getAuthorization(connection);
    if (authorization instanceof Error) {
      this.logger.error({
        event: "workspace-authorization-failed",
        error: authorization,
      });
      respond(request, response, 502, this.corsOrigins);
      return;
    }

    await forwardWorkspaceRequest({
      request,
      response,
      origin: connection.origin,
      authorization,
      corsOrigins: this.corsOrigins,
      logger: this.logger,
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
  corsOrigins: readonly string[];
  logger: Logger;
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
        ctx.response.writeHead(statusCode, {
          ...forwardedHeaders(upstreamResponse.headers),
          ...corsHeaders(ctx.request, ctx.corsOrigins),
        });
        upstreamResponse.pipe(ctx.response);
        ctx.response.once("finish", resolve);
        ctx.response.once("close", () => {
          upstreamResponse.destroy();
          resolve();
        });
      },
    );

    upstreamRequest.once("error", (cause) => {
      ctx.logger.error({
        event: "workspace-gateway-request-failed",
        error: new WorkspaceGatewayError({
          detail: "forward request",
          cause,
        }),
      });
      if (!ctx.response.headersSent)
        respond(ctx.request, ctx.response, 502, ctx.corsOrigins);
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
