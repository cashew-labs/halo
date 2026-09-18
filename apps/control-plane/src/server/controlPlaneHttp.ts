import fs from "node:fs/promises";
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { RPCHandler } from "@orpc/server/node";
import {
  RequestHeadersHandlerPlugin,
  ResponseHeadersHandlerPlugin,
} from "@orpc/server/plugins";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Logger } from "@get-halo/logger";
import * as errore from "errore";
import {
  type AuthService,
  DesktopAuthRequiredError,
  InvalidDesktopSignInRequestError,
  InvalidGoogleAccessTokenError,
} from "../auth/AuthService.js";
import {
  controlPlaneRpcRouter,
  type ControlPlaneContext,
} from "./controlPlaneRpcRouter.js";
import type { TraceIngestion } from "../traces/TraceIngestion.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import {
  isWorkspaceProxyRequest,
  WorkspaceGateway,
} from "../workspace/proxy.js";

const googleAccessTokenSessionSchema = Type.Object({
  accessToken: Type.String({ minLength: 1 }),
});

const requestUrlBase = "http://localhost";
const webContentSecurityPolicy = [
  "base-uri 'none'",
  "connect-src 'self'",
  "default-src 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'self'",
  "img-src 'self' blob: data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join("; ");

class ControlPlaneHttpError extends errore.createTaggedError({
  name: "ControlPlaneHttpError",
  message: "Control plane HTTP failed: $detail",
}) {}

export type ListeningControlPlaneHttp = {
  origin: string;
  server: HttpServer;
};

export async function listenControlPlaneHttp(host: string, port: number) {
  const server = createServer(respondStarting);

  return await new Promise<ListeningControlPlaneHttp | ControlPlaneHttpError>(
    (resolve) => {
      server.once("error", (error) => {
        resolve(
          new ControlPlaneHttpError({ detail: "listen failed", cause: error }),
        );
      });

      server.listen(port, host, () => {
        // SAFETY: Node returns a TCP address after successfully listening with a numeric port.
        const address = server.address() as AddressInfo;

        resolve({
          origin: `http://${host}:${address.port}`,
          server,
        });
      });
    },
  );
}

export function serveControlPlaneHttp(ctx: {
  server: HttpServer;
  auth: AuthService;
  corsOrigins: readonly string[];
  googleAccessTokenSessions: boolean;
  logger: Logger;
  workspace: WorkspaceService;
  webRoot: string;
  traces?: TraceIngestion;
}) {
  const { server, auth, workspace, webRoot, traces } = ctx;
  const rpc = new RPCHandler<ControlPlaneContext>(controlPlaneRpcRouter, {
    plugins: [
      new RequestHeadersHandlerPlugin(),
      new ResponseHeadersHandlerPlugin(),
    ],
  });
  const gateway = new WorkspaceGateway({
    auth,
    corsOrigins: ctx.corsOrigins,
    logger: ctx.logger,
    workspace,
  });

  server.removeListener("request", respondStarting);
  server.on("request", async (request, response) => {
    await routeControlPlaneRequest({
      request,
      response,
      auth,
      googleAccessTokenSessions: ctx.googleAccessTokenSessions,
      workspace,
      gateway,
      logger: ctx.logger,
      traces,
      rpc,
      webRoot,
    });
  });
}

export async function closeControlPlaneHttp(server: HttpServer) {
  const closing = new Promise<undefined | ControlPlaneHttpError>((resolve) => {
    server.close((error) => {
      if (error !== undefined) {
        resolve(
          new ControlPlaneHttpError({ detail: "close failed", cause: error }),
        );
        return;
      }

      resolve(undefined);
    });
  });

  server.closeAllConnections();
  return await closing;
}

function respondStarting(_request: IncomingMessage, response: ServerResponse) {
  response.writeHead(503).end("Control plane is starting.");
}

async function routeControlPlaneRequest(ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  auth: AuthService;
  googleAccessTokenSessions: boolean;
  gateway: WorkspaceGateway;
  logger: Logger;
  traces?: TraceIngestion;
  workspace: WorkspaceService;
  rpc: RPCHandler<ControlPlaneContext>;
  webRoot: string;
}) {
  const { request, response, auth, workspace, gateway, rpc, webRoot } = ctx;
  const url = new URL(
    request.url === undefined ? "/" : request.url,
    requestUrlBase,
  );

  if (isPathWithin(url.pathname, "/api/traces")) {
    if (ctx.traces === undefined) {
      response.writeHead(503).end();
      return;
    }
    await ctx.traces.serve(request, response, url);
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200).end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/desktop-auth/start") {
    await serveDesktopAuthStart(response, auth, url, ctx.logger);
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/desktop-auth/complete"
  ) {
    await serveDesktopAuthCompletion(request, response, auth, url, ctx.logger);
    return;
  }

  if (
    ctx.googleAccessTokenSessions &&
    request.method === "POST" &&
    url.pathname === "/api/dev/google-session"
  ) {
    await serveGoogleAccessTokenSession(request, response, auth, ctx.logger);
    return;
  }

  if (isBetterAuthRequest(url)) {
    await serveBetterAuth(request, response, auth, ctx.logger);
    return;
  }

  if (isWorkspaceProxyRequest(url)) {
    await gateway.serve(request, response);
    return;
  }

  if (isPathWithin(url.pathname, "/rpc")) {
    await serveControlPlaneRpc({ request, response, auth, workspace, rpc });
    return;
  }

  if (
    isPathWithin(url.pathname, "/api") ||
    isPathWithin(url.pathname, "/health")
  ) {
    response.writeHead(404).end();
    return;
  }

  await serveWebApp({
    request,
    response,
    url,
    webRoot,
    logger: ctx.logger,
  });
}

function isPathWithin(pathname: string, root: string) {
  return pathname === root || pathname.startsWith(`${root}/`);
}

async function serveDesktopAuthStart(
  response: ServerResponse,
  auth: AuthService,
  url: URL,
  logger: Logger,
) {
  const callback = url.searchParams.get("callback");
  const state = url.searchParams.get("state");

  if (callback === null || state === null) {
    response.writeHead(400).end("Invalid desktop sign-in request.");
    return;
  }

  const started = await auth.startDesktopSignIn({ callback, state });

  if (started instanceof InvalidDesktopSignInRequestError) {
    response.writeHead(400).end("Invalid desktop sign-in request.");
    return;
  }

  if (started instanceof Error) {
    logger.error({ event: "desktop-auth-start-failed", error: started });
    response.writeHead(500).end();
    return;
  }

  response
    .writeHead(302, {
      "cache-control": "no-store",
      location: started.authorizationUrl,
      "referrer-policy": "no-referrer",
      "set-cookie": started.headers.getSetCookie(),
    })
    .end();
}

async function serveDesktopAuthCompletion(
  request: IncomingMessage,
  response: ServerResponse,
  auth: AuthService,
  url: URL,
  logger: Logger,
) {
  const callback = url.searchParams.get("callback");
  const state = url.searchParams.get("state");

  if (callback === null || state === null) {
    response.writeHead(400).end("Invalid desktop sign-in request.");
    return;
  }

  const location = await auth.completeDesktopSignIn(requestHeaders(request), {
    callback,
    state,
  });

  if (location instanceof InvalidDesktopSignInRequestError) {
    response.writeHead(400).end("Invalid desktop sign-in request.");
    return;
  }

  if (location instanceof DesktopAuthRequiredError) {
    response.writeHead(401).end("Google sign-in has not completed.");
    return;
  }

  if (location instanceof Error) {
    logger.error({ event: "desktop-auth-complete-failed", error: location });
    response.writeHead(500).end();
    return;
  }

  response
    .writeHead(302, {
      "cache-control": "no-store",
      location: location.toString(),
      "referrer-policy": "no-referrer",
    })
    .end();
}

function isBetterAuthRequest(url: URL) {
  return url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/");
}

async function serveGoogleAccessTokenSession(
  request: IncomingMessage,
  response: ServerResponse,
  auth: AuthService,
  logger: Logger,
) {
  const body = await readJsonBody(request);
  if (body instanceof Error) {
    response.writeHead(400).end("Invalid Google access token session request.");
    return;
  }
  if (!Value.Check(googleAccessTokenSessionSchema, body)) {
    response.writeHead(400).end("Invalid Google access token session request.");
    return;
  }

  const session = await auth.signInWithGoogleAccessToken(body.accessToken);
  if (session instanceof InvalidGoogleAccessTokenError) {
    response.writeHead(401).end("Google access token is invalid.");
    return;
  }
  if (session instanceof Error) {
    logger.error({
      event: "google-access-token-session-failed",
      error: session,
    });
    response.writeHead(500).end();
    return;
  }

  const payload = Buffer.from(`${JSON.stringify(session)}\n`);
  response
    .writeHead(200, {
      "cache-control": "no-store",
      "content-length": payload.byteLength,
      "content-type": "application/json; charset=utf-8",
    })
    .end(payload);
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return errore.try({
    // SAFETY: JSON.parse is untyped; callers validate the result with TypeBox.
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new ControlPlaneHttpError({ detail: "parse JSON body", cause }),
  });
}

async function serveBetterAuth(
  request: IncomingMessage,
  response: ServerResponse,
  auth: AuthService,
  logger: Logger,
) {
  const handled = await auth.handleHttp(request, response);

  if (handled instanceof Error) {
    logger.error({ event: "better-auth-failed", error: handled });
    if (!response.writableEnded) response.writeHead(500).end();
  }
}

async function serveControlPlaneRpc(ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  auth: AuthService;
  workspace: WorkspaceService;
  rpc: RPCHandler<ControlPlaneContext>;
}) {
  const { request, response, auth, workspace, rpc } = ctx;
  const handled = await rpc.handle(request, response, {
    prefix: "/rpc",
    context: { auth, workspace },
  });

  if (handled.matched) return;

  response.writeHead(404).end();
}

async function serveWebApp(ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  webRoot: string;
  logger: Logger;
}) {
  const { request, response, url, webRoot } = ctx;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(404).end();
    return;
  }

  const requestedPath = path.posix.basename(url.pathname).includes(".")
    ? url.pathname.slice(1)
    : "index.html";
  const root = path.resolve(webRoot);
  const filePath = path.resolve(root, requestedPath);

  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(404).end();
    return;
  }

  const file = await readWebFile(filePath);
  if (file instanceof Error) {
    ctx.logger.error({ event: "web-asset-read-failed", error: file });
    response.writeHead(500).end();
    return;
  }
  if (file === undefined) {
    response.writeHead(404).end();
    return;
  }

  response.writeHead(200, {
    "cache-control": webCacheControl(url.pathname),
    "content-length": file.byteLength,
    "content-security-policy": webContentSecurityPolicy,
    "content-type": webContentType(filePath),
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else response.end(file);
}

function webCacheControl(pathname: string) {
  if (pathname.startsWith("/assets/")) {
    return "public, max-age=31536000, immutable";
  }

  return "no-cache";
}

async function readWebFile(filePath: string) {
  return await fs.readFile(filePath).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT" || cause.code === "EISDIR") return undefined;
    return new ControlPlaneHttpError({ detail: "read web asset", cause });
  });
}

function webContentType(filePath: string) {
  const extension = path.extname(filePath);
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".ico") return "image/x-icon";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".webp") return "image/webp";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
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
