import fs from "node:fs";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { createProxyServer, proxyUpgrade } from "httpxy";
import * as errore from "errore";
import type { ExtensionHost } from "./ExtensionHost.js";

const extensionPathPrefix = "/extensions/";
const extensionProxy = createProxyServer();

class ExtensionProxyError extends errore.createTaggedError({
  name: "ExtensionProxyError",
  message: "Extension proxy failed: $detail",
}) {}

export function isExtensionProxyRequest(url: URL) {
  return url.pathname.startsWith(extensionPathPrefix);
}

export async function serveExtensionRequest(ctx: {
  extensions: ExtensionHost;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}) {
  const route = parseExtensionRoute(ctx.url);
  if (route instanceof Error) {
    ctx.response.writeHead(400).end();
    return;
  }

  const origin = ctx.extensions.getOrigin(route.id);
  if (origin === undefined) {
    ctx.response.writeHead(404).end();
    return;
  }

  const target = new URL(`${route.path}${ctx.url.search}`, origin);
  await forwardExtensionRequest({ ...ctx, target });
}

export async function serveExtensionUpgrade(ctx: {
  extensions: ExtensionHost;
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  url: URL;
}) {
  const route = parseExtensionRoute(ctx.url);
  if (route instanceof Error) {
    respondToUpgrade(ctx.socket, 400);
    return;
  }

  const origin = ctx.extensions.getOrigin(route.id);
  if (origin === undefined) {
    respondToUpgrade(ctx.socket, 404);
    return;
  }

  const target = new URL(`${route.path}${ctx.url.search}`, origin);
  // #region agent log
  appendAgentLog({
    hypothesisId: "H1,H2,H4",
    location: "extensionProxy.ts:serveExtensionUpgrade:beforePrepare",
    message: "Workspace extension upgrade before request preparation",
    data: {
      incoming: safeUrl(ctx.request.url),
      target: safeUrl(target.toString()),
      headers: safeUpgradeHeaders(ctx.request),
      headBytes: ctx.head.byteLength,
    },
    timestamp: Date.now(),
  });
  // #endregion
  prepareRequest(ctx.request, target);
  // #region agent log
  appendAgentLog({
    hypothesisId: "H1,H2,H4",
    location: "extensionProxy.ts:serveExtensionUpgrade:afterPrepare",
    message: "Workspace extension upgrade after request preparation",
    data: {
      outgoing: safeUrl(ctx.request.url),
      targetOrigin: target.origin,
      headers: safeUpgradeHeaders(ctx.request),
    },
    timestamp: Date.now(),
  });
  // #endregion
  const proxied = await proxyUpgrade(
    target.origin,
    ctx.request,
    ctx.socket,
    ctx.head,
    { xfwd: false },
  ).catch(
    (cause) =>
      new ExtensionProxyError({
        detail: "WebSocket upgrade",
        cause,
      }),
  );
  // #region agent log
  appendAgentLog({
    hypothesisId: "H3",
    location: "extensionProxy.ts:serveExtensionUpgrade:proxyResult",
    message: "Workspace extension upgrade proxy completed",
    data: {
      error: proxied instanceof Error ? proxied.message : undefined,
      clientDestroyed: ctx.socket.destroyed,
      upstreamDestroyed:
        proxied instanceof Error ? undefined : proxied.destroyed,
    },
    timestamp: Date.now(),
  });
  // #endregion
  if (proxied instanceof Error) {
    console.error(proxied);
  }
}

function parseExtensionRoute(url: URL) {
  const route = url.pathname.slice(extensionPathPrefix.length);
  const separator = route.indexOf("/");
  if (separator === -1) {
    return new ExtensionProxyError({ detail: "missing extension path" });
  }

  const id = errore.try({
    try: () => decodeURIComponent(route.slice(0, separator)),
    catch: (cause) =>
      new ExtensionProxyError({ detail: "invalid extension id", cause }),
  });
  if (id instanceof Error) return id;

  return { id, path: route.slice(separator) };
}

async function forwardExtensionRequest(ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  target: URL;
}) {
  prepareRequest(ctx.request, ctx.target);
  const proxied = await extensionProxy
    .web(ctx.request, ctx.response, {
      target: ctx.target.origin,
      xfwd: false,
    })
    .catch((cause) => new ExtensionProxyError({ detail: "request", cause }));
  if (!(proxied instanceof Error)) return;

  console.error(proxied);
  if (!ctx.response.headersSent) ctx.response.writeHead(502);
  if (!ctx.response.writableEnded) ctx.response.end();
}

function prepareRequest(request: IncomingMessage, target: URL) {
  const publicHost = request.headers.host;
  const forwardedProtocol = firstHeader(request.headers["x-forwarded-proto"]);
  removePrivateHeaders(request.headers);
  request.headers.host = target.host;
  request.headers["x-forwarded-host"] = publicHost;
  request.headers["x-forwarded-proto"] =
    forwardedProtocol === undefined ? "http" : forwardedProtocol;
  request.url = `${target.pathname}${target.search}`;
}

function removePrivateHeaders(headers: IncomingHttpHeaders) {
  delete headers.authorization;
  delete headers.cookie;
  delete headers.forwarded;
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
}

function firstHeader(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function appendAgentLog(entry: {
  hypothesisId: string;
  location: string;
  message: string;
  data: object;
  timestamp: number;
}) {
  fs.appendFileSync("/opt/cursor/logs/debug.log", `${JSON.stringify(entry)}\n`);
}

function safeUpgradeHeaders(request: IncomingMessage) {
  return {
    connection: request.headers.connection,
    forwarded: request.headers.forwarded,
    host: request.headers.host,
    origin: request.headers.origin,
    secWebSocketProtocolPresent:
      request.headers["sec-websocket-protocol"] !== undefined,
    upgrade: request.headers.upgrade,
    xForwardedHost: request.headers["x-forwarded-host"],
    xForwardedProto: request.headers["x-forwarded-proto"],
  };
}

function safeUrl(value: string | undefined) {
  const url = new URL(value === undefined ? "/" : value, "http://localhost");
  return {
    pathname: url.pathname,
    queryKeys: [...url.searchParams.keys()],
  };
}

function respondToUpgrade(socket: Duplex, statusCode: number) {
  socket.end(
    `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode]}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n",
  );
}
