import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { RPCHandler } from "@orpc/server/node";
import {
  RequestHeadersHandlerPlugin,
  ResponseHeadersHandlerPlugin,
} from "@orpc/server/plugins";
import * as errore from "errore";
import {
  type AuthService,
  DesktopAuthRequiredError,
  InvalidDesktopSignInRequestError,
} from "../auth/AuthService.js";
import {
  controlPlaneRpcRouter,
  type ControlPlaneContext,
} from "./controlPlaneRpcRouter.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import {
  isWorkspaceProxyRequest,
  WorkspaceGateway,
} from "../workspace/proxy.js";

const requestUrlBase = "http://localhost";

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
  workspace: WorkspaceService;
}) {
  const { server, auth, workspace } = ctx;
  const rpc = new RPCHandler<ControlPlaneContext>(controlPlaneRpcRouter, {
    plugins: [
      new RequestHeadersHandlerPlugin(),
      new ResponseHeadersHandlerPlugin(),
    ],
  });
  const gateway = new WorkspaceGateway({ auth, workspace });

  server.removeListener("request", respondStarting);
  server.on("request", async (request, response) => {
    await routeControlPlaneRequest({
      request,
      response,
      auth,
      workspace,
      gateway,
      rpc,
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
  gateway: WorkspaceGateway;
  workspace: WorkspaceService;
  rpc: RPCHandler<ControlPlaneContext>;
}) {
  const { request, response, auth, workspace, gateway, rpc } = ctx;
  const url = new URL(
    request.url === undefined ? "/" : request.url,
    requestUrlBase,
  );

  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200).end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/desktop-auth/start") {
    await serveDesktopAuthStart(response, auth, url);
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/desktop-auth/complete"
  ) {
    await serveDesktopAuthCompletion(request, response, auth, url);
    return;
  }

  if (isBetterAuthRequest(url)) {
    await serveBetterAuth(request, response, auth);
    return;
  }

  if (isWorkspaceProxyRequest(url)) {
    await gateway.serve(request, response);
    return;
  }

  await serveControlPlaneRpc({ request, response, auth, workspace, rpc });
}

async function serveDesktopAuthStart(
  response: ServerResponse,
  auth: AuthService,
  url: URL,
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
    console.error(started);
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
    console.error(location);
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

async function serveBetterAuth(
  request: IncomingMessage,
  response: ServerResponse,
  auth: AuthService,
) {
  const handled = await auth.handleHttp(request, response);

  if (handled instanceof Error) {
    console.error(handled);
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
