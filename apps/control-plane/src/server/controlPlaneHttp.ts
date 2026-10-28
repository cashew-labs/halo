import type { WorkspaceUpdates } from "../workspace/WorkspaceUpdates.js";
import { serveWorkspaceUpdate } from "../workspace/workspaceUpdateHttp.js";
import type { MarketingLinks } from "../marketing/MarketingLinks.js";
import type { Logger, LoggerApi } from "@get-halo/logger";
import { serveMarketingLink } from "../marketing/serveMarketingLink.js";
import type { GmailService } from "../automations/GmailService.js";
import type { GmailPushReceiver } from "../automations/gmailHttp.js";
import { serveWebhook } from "../automations/webhookHttp.js";
import type { WebhookService } from "../automations/WebhookService.js";
import {
  serveAutomationState,
  serveAutomationGmailConnections,
} from "../automations/automationStateHttp.js";
import type { AutomationStore } from "../automations/AutomationStore.js";
import { serveAutomationSnapshot } from "../automations/automationSnapshotHttp.js";
import { acceptsProtocol, protocolHeader } from "@get-halo/client";
import {
  controlPlaneProtocolVersion,
  controlPlaneSupportedProtocols,
} from "@get-halo/shared/controlPlaneContract";
import { ORPCError } from "@orpc/server";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http, {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import path from "node:path";
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
  WorkspaceAuthenticationRequiredError,
} from "../auth/AuthService.js";
import {
  controlPlaneRpcRouter,
  type ControlPlaneContext,
} from "./controlPlaneRpcRouter.js";
import type { TraceIngestion } from "../traces/TraceIngestion.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import type { IntegrationService } from "../integrations/IntegrationService.js";
import { setupBrowserCookies } from "../integrations/setupBrowserCookie.js";
import {
  isWorkspaceProxyRequest,
  WorkspaceGateway,
  type WorkspaceAuthorization,
} from "../workspace/proxy.js";
import type { AppService } from "../apps/AppService.js";
import type { AppGateway } from "../apps/AppGateway.js";
import type { AppStore } from "../apps/AppStore.js";
import {
  creatorHandle,
  creatorOrigin,
  isCreatorHost,
} from "../apps/creatorHost.js";
import {
  isAppHandoffRequest,
  serveAppHandoff,
} from "../apps/appHandoffHttp.js";
import {
  isAppRuntimeRequest,
  serveAppRuntime,
} from "../apps/appRuntimeHttp.js";
import { isTemplateRequest, serveTemplate } from "../apps/templateHttp.js";

import { workspaceInferencePath } from "@get-halo/config/inference";
import {
  type WorkspaceInference,
  serveWorkspaceInference,
} from "../inference/workspaceInference.js";
import { serveWorkspaceIdleReport } from "../workspace/workspaceIdleHttp.js";
import { serveWorkspaceAutomationSnapshot } from "../workspace/workspaceAutomationHttp.js";
import type { AutomationScheduleCoordinator } from "../workspace/AutomationScheduleCoordinator.js";

const requestUrlBase = "http://localhost";
function webContentSecurityPolicy(ctx: {
  marketing: boolean;
  scriptHashes: string[];
}) {
  const { marketing, scriptHashes } = ctx;
  return [
    "base-uri 'none'",
    `connect-src 'self'${marketing ? " https://buttondown.com https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com" : ""}`,
    "default-src 'self'",
    "font-src 'self' data:",
    "form-action 'self' https://buttondown.com",
    "frame-ancestors 'none'",
    `frame-src 'self'${marketing ? " https://cal.com https://app.cal.com" : ""}`,
    `img-src 'self' blob: data: https://gethalo.dev${marketing ? " https://www.googletagmanager.com https://*.google-analytics.com" : ""}`,
    "object-src 'none'",
    [
      "script-src 'self'",
      ...(marketing
        ? ["https://app.cal.com", "https://www.googletagmanager.com"]
        : []),
      ...scriptHashes,
    ].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join("; ");
}

/**
 * CSP hashes for an HTML document's attribute-free inline scripts, computed
 * from the served file so they cannot drift from its contents.
 */
function inlineScriptHashes(html: string) {
  // Browsers hash script text after normalizing line endings to LF. Like the
  // HTML parser, tag names are case-insensitive and the text ends at the first
  // `</script` followed by whitespace, `/`, or `>`.
  return [
    ...html
      .replaceAll("\r\n", "\n")
      .matchAll(/<script\s*>([\s\S]*?)<\/script[\s/>]/gi),
  ].map(
    ([, source]) =>
      `'sha256-${createHash("sha256").update(source!).digest("base64")}'`,
  );
}

class ControlPlaneHttpError extends errore.createTaggedError({
  name: "ControlPlaneHttpError",
  message: "Control plane HTTP failed: $detail",
}) {}

export type ListeningControlPlaneHttp = {
  origin: string;
  server: HttpServer;
};

export type ServingControlPlaneHttp = {
  close: () => void;
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
  logger: Logger;
  server: HttpServer;
  auth: AuthService;
  authorization: WorkspaceAuthorization;
  apps: AppService;
  marketing: MarketingLinks;
  marketingHostname?: string;
  marketingHomepageOrigin?: string;
  appStore: AppStore;
  appGateway: AppGateway;
  publicOrigin: string;
  workspace: WorkspaceService;
  workspaceUpdates: WorkspaceUpdates;
  integrations?: IntegrationService;
  automationSchedules: AutomationScheduleCoordinator;
  automationStore: AutomationStore;
  webhooks: WebhookService;
  gmail: GmailService;
  gmailPush: GmailPushReceiver;
  build?: { version: string; revision: string };
  webRoot: string;
  googleAnalyticsMeasurementId?: string;
  environment?: "production" | "staging" | "development";
  traces?: TraceIngestion;
  inference?: WorkspaceInference;
}) {
  const { server, auth, publicOrigin, workspace, webRoot, traces } = ctx;
  const marketingHostname =
    ctx.marketingHostname ??
    new URL(creatorOrigin({ publicOrigin, handle: "go" })).hostname;
  const upgradeSockets = new Set<Duplex>();
  const rpc = new RPCHandler<ControlPlaneContext>(controlPlaneRpcRouter, {
    clientInterceptors: [
      async ({ path: rpcPath, context, next }) => {
        if (
          rpcPath.join(".") !== "server.info" &&
          !acceptsProtocol({
            selected: context.reqHeaders?.get(protocolHeader) ?? undefined,
            supported: controlPlaneSupportedProtocols,
            legacy: controlPlaneProtocolVersion,
          })
        )
          throw new ORPCError("UNSUPPORTED_PROTOCOL", {
            data: { supportedProtocols: controlPlaneSupportedProtocols },
          });
        return await next();
      },
    ],
    plugins: [
      new RequestHeadersHandlerPlugin(),
      new ResponseHeadersHandlerPlugin(),
    ],
  });
  const gateway = new WorkspaceGateway({
    auth,
    authorization: ctx.authorization,
    publicOrigin,
    workspace,
  });

  server.removeListener("request", respondStarting);
  server.on("request", async (request, response) => {
    const logger = ctx.logger.scope("request", { requestId: randomUUID() });
    // The reserved go host belongs to Halo, before creator-app dispatch.
    if (
      request.headers.host?.toLowerCase().split(":")[0] === marketingHostname
    ) {
      await serveMarketingLink({
        logger: logger.scope("marketing"),
        request,
        response,
        homepageOrigin: ctx.marketingHomepageOrigin ?? publicOrigin,
        links: ctx.marketing,
      });
      return;
    }
    // Creator hosts serve apps only; no Halo route is reachable from them.
    const handle = creatorHandle({ publicOrigin, host: request.headers.host });
    // A subdomain that cannot be a handle is not Halo either.
    if (
      handle === undefined &&
      isCreatorHost({ publicOrigin, host: request.headers.host })
    ) {
      response.writeHead(404, { "cache-control": "no-store" }).end();
      return;
    }
    if (handle !== undefined) {
      const served = await ctx.appGateway
        .serve({
          request,
          response,
          handle,
          logger: logger.scope("app-gateway"),
        })
        .catch(
          (cause) =>
            new ControlPlaneHttpError({ detail: "serve app request", cause }),
        );
      if (served instanceof Error) {
        logger.error({ event: "app-request-failed", errorType: served.name });
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
      return;
    }
    stripCrossOriginCookies(request, publicOrigin);
    await routeControlPlaneRequest({
      workspaceUpdates: ctx.workspaceUpdates,
      logger,
      request,
      response,
      auth,
      workspace,
      automationSchedules: ctx.automationSchedules,
      automationStore: ctx.automationStore,
      webhooks: ctx.webhooks,
      gmail: ctx.gmail,
      gmailPush: ctx.gmailPush,
      gateway,
      traces,
      rpc,
      apps: ctx.apps,
      marketing: ctx.marketing,
      appStore: ctx.appStore,
      integrations: ctx.integrations,
      publicOrigin,
      webRoot,
      googleAnalyticsMeasurementId: ctx.googleAnalyticsMeasurementId,
      environment: ctx.environment,
      build: ctx.build,
      inference: ctx.inference,
    });
  });
  server.on("upgrade", async (request, socket, head) => {
    const logger = ctx.logger.scope("upgrade", { requestId: randomUUID() });
    upgradeSockets.add(socket);
    socket.once("close", () => upgradeSockets.delete(socket));
    if (
      request.headers.host?.toLowerCase().split(":")[0] === marketingHostname ||
      isCreatorHost({ publicOrigin, host: request.headers.host })
    ) {
      respondToUpgrade(socket, 404);
      return;
    }
    stripCrossOriginCookies(request, publicOrigin);
    const url = new URL(
      request.url === undefined ? "/" : request.url,
      requestUrlBase,
    );
    if (!isWorkspaceProxyRequest(url)) {
      respondToUpgrade(socket, 404);
      return;
    }
    await gateway.upgrade(
      request,
      socket,
      head,
      logger.scope("workspace-proxy"),
    );
  });
  return {
    close() {
      for (const socket of upgradeSockets) socket.destroy();
    },
  } satisfies ServingControlPlaneHttp;
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

/**
 * Cookies authenticate only requests from Halo's own origin. Sibling creator
 * hosts are same-site, so SameSite does not stop their requests from carrying
 * Halo's cookies; explicit bearer credentials still work from anywhere.
 */
function stripCrossOriginCookies(
  request: IncomingMessage,
  publicOrigin: string,
) {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== publicOrigin)
    delete request.headers.cookie;
}

function respondStarting(_request: IncomingMessage, response: ServerResponse) {
  response.writeHead(503).end("Control plane is starting.");
}

function respondToUpgrade(socket: Duplex, statusCode: number) {
  socket.end(
    `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode]}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n",
  );
}

async function routeControlPlaneRequest(ctx: {
  logger: Logger;
  request: IncomingMessage;
  response: ServerResponse;
  auth: AuthService;
  apps: AppService;
  marketing: MarketingLinks;
  appStore: AppStore;
  publicOrigin: string;
  gateway: WorkspaceGateway;
  traces?: TraceIngestion;
  inference?: WorkspaceInference;
  workspace: WorkspaceService;
  workspaceUpdates: WorkspaceUpdates;
  integrations?: IntegrationService;
  automationSchedules: AutomationScheduleCoordinator;
  automationStore: AutomationStore;
  webhooks: WebhookService;
  gmail: GmailService;
  gmailPush: GmailPushReceiver;
  build?: { version: string; revision: string };
  rpc: RPCHandler<ControlPlaneContext>;
  webRoot: string;
  googleAnalyticsMeasurementId?: string;
  environment?: "production" | "staging" | "development";
}) {
  const { request, response, auth, workspace, gateway, rpc, webRoot, logger } =
    ctx;
  const url = new URL(
    request.url === undefined ? "/" : request.url,
    requestUrlBase,
  );

  if (
    request.method === "GET" &&
    url.pathname === "/api/integrations/oauth/callback"
  ) {
    const headers = requestHeaders(request);
    const session = await auth.getSession({ headers });
    const result = await ctx.integrations?.oauthCallback({
      state: url.searchParams.get("state") ?? "",
      code: url.searchParams.has("error")
        ? undefined
        : (url.searchParams.get("code") ?? undefined),
      userId: session instanceof Error ? undefined : session?.user.id,
      browsers: setupBrowserCookies(headers, ctx.publicOrigin),
    });
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    if (result === undefined || result instanceof Error) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("Invalid or expired authorization callback.");
      return;
    }
    response.writeHead(303, { location: result.setupUrl });
    response.end();
    return;
  }

  if (isAppHandoffRequest(url)) {
    await serveAppHandoff({
      logger: logger.scope("app-handoff"),
      request,
      response,
      url,
      auth,
      store: ctx.appStore,
      publicOrigin: ctx.publicOrigin,
    });
    return;
  }

  if (isTemplateRequest(url)) {
    await serveTemplate({
      logger: logger.scope("template"),
      request,
      response,
      url,
      auth,
      store: ctx.appStore,
      apps: ctx.apps,
      publicOrigin: ctx.publicOrigin,
    });
    return;
  }

  if (isAppRuntimeRequest(url)) {
    await serveAppRuntime({
      request,
      response,
      url,
      apps: ctx.apps,
      logger: logger.scope("app-runtime"),
    });
    return;
  }

  if (
    [
      "/api/workspace-runtime/update",
      "/api/workspace-runtime/update-token",
    ].includes(url.pathname)
  ) {
    await serveWorkspaceUpdate({
      request,
      response,
      updates: ctx.workspaceUpdates,
      token: url.pathname.endsWith("-token"),
    });
    return;
  }

  if (url.pathname === "/api/workspace-runtime/idle") {
    await serveWorkspaceIdleReport(
      request,
      response,
      workspace,
      logger.scope("workspace-idle"),
    );
    return;
  }

  if (url.pathname === "/api/automation-events/gmail") {
    await ctx.gmailPush.serve(request, response, logger.scope("gmail-push"));
    return;
  }

  const webhook = /^\/api\/webhooks\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
  if (webhook?.[1] !== undefined) {
    await serveWebhook({
      logger: logger.scope("webhook"),
      request,
      response,
      url,
      webhookId: webhook[1],
      webhooks: ctx.webhooks,
      store: ctx.automationStore,
    });
    return;
  }

  if (url.pathname === "/api/workspace-runtime/automations/gmail/connections") {
    await serveAutomationGmailConnections({
      logger: logger.scope("gmail-connections"),
      request,
      response,
      workspace,
      integrations: ctx.integrations,
    });
    return;
  }
  if (
    url.pathname === "/api/workspace-runtime/automations/schedules" &&
    request.method === "POST"
  ) {
    await serveWorkspaceAutomationSnapshot(
      request,
      response,
      workspace,
      ctx.automationSchedules,
      logger.scope("automation-schedules"),
    );
    return;
  }
  const automationState =
    /^\/api\/workspace-runtime\/automations\/([a-zA-Z0-9_-]+)(?:\/(reveal|rotate))?$/.exec(
      url.pathname,
    );
  if (automationState?.[1] !== undefined) {
    await serveAutomationState({
      logger: logger.scope("automation-state"),
      request,
      response,
      automationId: automationState[1],
      workspace,
      store: ctx.automationStore,
      webhooks: ctx.webhooks,
      secretAction: automationState[2],
      gmail: ctx.gmail,
    });
    return;
  }

  if (url.pathname === "/api/workspace-runtime/automations") {
    await serveAutomationSnapshot(
      request,
      response,
      workspace,
      ctx.automationStore,
      logger.scope("automation-snapshot"),
    );
    ctx.gmail.schedule();
    return;
  }

  if (url.pathname === `${workspaceInferencePath}/chat/completions`) {
    await serveWorkspaceInference({
      logger: logger.scope("inference"),
      request,
      response,
      workspace,
      apps: ctx.apps,
      inference: ctx.inference,
    });
    return;
  }

  if (isPathWithin(url.pathname, "/api/traces")) {
    if (ctx.traces === undefined) {
      response.writeHead(503).end();
      return;
    }
    await ctx.traces.serve(request, response, url, logger.scope("traces"));
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200).end();
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/workspace-runtime/identity"
  ) {
    response.setHeader("cache-control", "no-store");
    const headers = new Headers();
    if (request.headers.authorization !== undefined)
      headers.set("authorization", request.headers.authorization);
    const identity = await workspace.authenticateRuntime(headers);
    if (identity instanceof WorkspaceAuthenticationRequiredError) {
      response.writeHead(401).end();
      return;
    }
    if (identity instanceof Error) {
      logger.error({
        event: "workspace-identity-failed",
        errorType: identity.name,
      });
      response.writeHead(500).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(identity));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/desktop-auth/start") {
    await serveDesktopAuthStart(
      response,
      auth,
      url,
      logger.scope("desktop-auth"),
    );
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/desktop-auth/complete"
  ) {
    await serveDesktopAuthCompletion(
      request,
      response,
      auth,
      url,
      logger.scope("desktop-auth"),
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/desktop-auth/error") {
    serveDesktopAuthError(response, auth, url);
    return;
  }

  if (isBetterAuthRequest(url)) {
    await serveBetterAuth(request, response, auth, logger.scope("auth"));
    return;
  }

  if (isWorkspaceProxyRequest(url)) {
    await gateway.serve(request, response, logger.scope("workspace-proxy"));
    return;
  }

  if (isPathWithin(url.pathname, "/rpc")) {
    await serveControlPlaneRpc({
      workspaceUpdates: ctx.workspaceUpdates,
      request,
      response,
      auth,
      publicOrigin: ctx.publicOrigin,
      workspace,
      rpc,
      apps: ctx.apps,
      marketing: ctx.marketing,
      integrations: ctx.integrations,
      build: ctx.build,
    });
    return;
  }

  if (
    isPathWithin(url.pathname, "/api") ||
    isPathWithin(url.pathname, "/health")
  ) {
    response.writeHead(404).end();
    return;
  }

  const session =
    url.pathname === "/"
      ? await auth.getSession({ headers: requestHeaders(request) })
      : undefined;
  if (session instanceof Error)
    logger.error({ event: "page-session-failed", errorType: session.name });
  const marketing =
    url.pathname === "/newsletter/check-email" ||
    url.pathname === "/newsletter/joined" ||
    (url.pathname === "/" && session === undefined);
  await serveWebApp({
    logger: logger.scope("web"),
    request,
    response,
    url,
    webRoot,
    marketing,
    googleAnalyticsMeasurementId: ctx.googleAnalyticsMeasurementId,
    environment: ctx.environment,
  });
}

function isPathWithin(pathname: string, root: string) {
  return pathname === root || pathname.startsWith(`${root}/`);
}

async function serveDesktopAuthStart(
  response: ServerResponse,
  auth: AuthService,
  url: URL,
  logger: LoggerApi,
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
    logger.error({
      event: "desktop-sign-in-start-failed",
      errorType: started.name,
    });
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
  logger: LoggerApi,
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
    logger.error({
      event: "desktop-sign-in-complete-failed",
      errorType: location.name,
    });
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

function serveDesktopAuthError(
  response: ServerResponse,
  auth: AuthService,
  url: URL,
) {
  const error = url.searchParams.get("error");
  const callback = url.searchParams.get("callback");
  const state = url.searchParams.get("state");
  if (callback !== null && state !== null) {
    const location = auth.failDesktopSignIn(
      { callback, state },
      error === null || error === "" ? "sign_in_failed" : error,
    );
    if (location instanceof Error) {
      response.writeHead(400).end("Invalid desktop sign-in request.");
      return;
    }
    response
      .writeHead(302, {
        "cache-control": "no-store",
        location: location.toString(),
        "referrer-policy": "no-referrer",
      })
      .end();
    return;
  } // coverage-exempt: non-executable branch terminator; redirect and fallback responses are tested
  const detail =
    error === null || error === ""
      ? "Halo could not finish signing in. Return to the app and try again."
      : `Halo could not finish signing in (${error}). Return to the app and try again.`;

  response
    .writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    })
    .end(detail);
}

function isBetterAuthRequest(url: URL) {
  return url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/");
}

async function serveBetterAuth(
  request: IncomingMessage,
  response: ServerResponse,
  auth: AuthService,
  logger: LoggerApi,
) {
  const handled = await auth.handleHttp(request, response);

  if (handled instanceof Error) {
    logger.error({ event: "auth-request-failed", errorType: handled.name });
    if (!response.writableEnded) response.writeHead(500).end();
  }
}

async function serveControlPlaneRpc(ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  auth: AuthService;
  apps: AppService;
  marketing: MarketingLinks;
  publicOrigin: string;
  workspace: WorkspaceService;
  workspaceUpdates: WorkspaceUpdates;
  integrations?: IntegrationService;
  build?: { version: string; revision: string };
  rpc: RPCHandler<ControlPlaneContext>;
}) {
  const { request, response, auth, workspace, rpc } = ctx;
  const handled = await rpc.handle(request, response, {
    prefix: "/rpc",
    context: {
      workspaceUpdates: ctx.workspaceUpdates,
      auth,
      publicOrigin: ctx.publicOrigin,
      workspace,
      integrations: ctx.integrations,
      apps: ctx.apps,
      marketing: ctx.marketing,
      build: ctx.build,
    },
  });

  if (handled.matched) return;

  response.writeHead(404).end();
}

async function serveWebApp(ctx: {
  logger: LoggerApi;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  webRoot: string;
  googleAnalyticsMeasurementId?: string;
  environment?: "production" | "staging" | "development";
  marketing: boolean;
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

  // Every environment shares one build; development/ and staging/ replace
  // same-named root files, such as the logo.
  const overrideFile =
    ctx.environment === undefined || ctx.environment === "production"
      ? undefined
      : await readWebFile(path.resolve(root, ctx.environment, requestedPath));
  const file = overrideFile ?? (await readWebFile(filePath));
  if (file instanceof Error) {
    ctx.logger.error({ event: "web-asset-read-failed", errorType: file.name });
    response.writeHead(500).end();
    return;
  }
  if (file === undefined) {
    response.writeHead(404).end();
    return;
  }

  const measurementId = ctx.marketing ? ctx.googleAnalyticsMeasurementId : "";
  const extensionRoute = /^\/extensions\/([^/]+)\/?$/i.exec(url.pathname);
  const extensionId =
    extensionRoute === null
      ? undefined
      : errore.try({
          try: () => decodeURIComponent(extensionRoute[1]!),
          catch: (cause) =>
            new ControlPlaneHttpError({ detail: "decode extension ID", cause }),
        });
  if (extensionId instanceof Error) {
    ctx.logger.warn({
      event: "extension-id-decode-failed",
      errorType: extensionId.name,
    });
    response.writeHead(400).end();
    return;
  }
  // WebKit retains the first manifest loader for a document. Extension pages
  // insert their manifest only after the workspace supplies the display name.
  const manifestLink =
    extensionId === undefined
      ? '<link rel="manifest" href="/manifest.json" />'
      : `<meta name="halo-extension-id" content="${encodeURIComponent(extensionId)}" />`;
  const content =
    requestedPath === "manifest.json" && url.searchParams.has("extension")
      ? extensionWebManifest({ file, url })
      : requestedPath === "index.html"
        ? Buffer.from(
            file
              .toString()
              .replace(
                '<meta name="halo-ga-measurement-id" content="" />',
                `<meta name="halo-ga-measurement-id" content="${measurementId ?? ""}" />`,
              )
              .replace(
                '<meta name="halo-environment" content="" />',
                `<meta name="halo-environment" content="${ctx.environment ?? ""}" />`,
              )
              .replace(
                '<link rel="manifest" href="/manifest.json" />',
                manifestLink,
              ),
          )
        : file;
  if (content instanceof Error) {
    ctx.logger.error({
      event: "web-manifest-read-failed",
      errorType: content.name,
    });
    response.writeHead(500).end();
    return;
  }
  response.writeHead(200, {
    "cache-control": webCacheControl(url.pathname),
    "content-length": content.byteLength,
    "content-security-policy": webContentSecurityPolicy({
      marketing: ctx.marketing,
      scriptHashes:
        path.extname(filePath) === ".html"
          ? inlineScriptHashes(content.toString("utf8"))
          : [],
    }),
    "content-type":
      requestedPath === "manifest.json"
        ? "application/manifest+json; charset=utf-8"
        : webContentType(filePath),
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else response.end(content);
}

type WebAppManifest = {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};

function extensionWebManifest({ file, url }: { file: Buffer; url: URL }) {
  const manifest = errore.try({
    // SAFETY: The file is Halo's bundled public/manifest.json, not request-supplied JSON.
    try: () => JSON.parse(file.toString("utf8")) as WebAppManifest,
    catch: (cause) =>
      new ControlPlaneHttpError({ detail: "read web manifest", cause }),
  });
  if (manifest instanceof Error) return manifest;
  // Branding comes from the page, not a workspace lookup: manifest fetches
  // omit credentials by default and must also work while signed out.
  const extensionId = url.searchParams.get("extension")!;
  const extensionPath = `/extensions/${encodeURIComponent(extensionId)}`;
  const displayName = url.searchParams.get("name") ?? extensionId;
  return Buffer.from(
    JSON.stringify({
      ...manifest,
      id: extensionPath,
      name: displayName,
      short_name: displayName,
      start_url: extensionPath,
      // Sign-in and its callback must remain inside the installed app.
      scope: "/",
    }),
  );
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
