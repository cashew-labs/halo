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
  fromGateway: boolean;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}) {
  const route = parseExtensionRoute(ctx.url);
  if (route instanceof Error) {
    ctx.response.writeHead(400).end();
    return;
  }

  const connection = ctx.extensions.getConnection(route.id);
  if (connection === undefined) {
    ctx.response.writeHead(404).end();
    return;
  }

  const target = new URL(`${route.path}${ctx.url.search}`, connection.origin);
  await forwardExtensionRequest({
    ...ctx,
    target,
    hostToken: connection.hostToken,
  });
}

export async function serveExtensionUpgrade(ctx: {
  extensions: ExtensionHost;
  fromGateway: boolean;
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

  const connection = ctx.extensions.getConnection(route.id);
  if (connection === undefined) {
    respondToUpgrade(ctx.socket, 404);
    return;
  }

  const target = new URL(`${route.path}${ctx.url.search}`, connection.origin);
  prepareRequest({ ...ctx, target });
  ctx.request.headers["x-halo-extension-token"] = connection.hostToken;
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
  extensions: ExtensionHost;
  hostToken: string;
  fromGateway: boolean;
  request: IncomingMessage;
  response: ServerResponse;
  target: URL;
}) {
  prepareRequest(ctx);
  ctx.request.headers["x-halo-extension-token"] = ctx.hostToken;
  ctx.request.headers["x-halo-viewer-token"] = ctx.extensions.issueViewerToken(
    firstHeader(ctx.request.headers["x-halo-viewer-id"]) ?? "owner",
  );
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

function prepareRequest(ctx: {
  request: IncomingMessage;
  target: URL;
  fromGateway: boolean;
}) {
  const { request, target, fromGateway } = ctx;
  // Only the authenticated control plane can supply the public origin.
  const publicHost = fromGateway
    ? (firstHeader(request.headers["x-halo-public-host"]) ??
      request.headers.host)
    : request.headers.host;
  const forwardedProtocol = fromGateway
    ? firstHeader(request.headers["x-halo-public-proto"])
    : undefined;
  const viewerId = fromGateway
    ? firstHeader(request.headers["x-halo-viewer-id"])
    : "owner";
  const viewerRole = fromGateway
    ? firstHeader(request.headers["x-halo-viewer-role"])
    : "owner";
  const viewerEmail = fromGateway
    ? firstHeader(request.headers["x-halo-viewer-email"])
    : undefined;
  removePrivateHeaders(request.headers);
  request.headers["x-halo-viewer-id"] = viewerId ?? "owner";
  request.headers["x-halo-viewer-role"] = viewerRole ?? "owner";
  if (viewerEmail !== undefined)
    request.headers["x-halo-viewer-email"] = viewerEmail;
  request.headers.host = target.host;
  request.headers["x-forwarded-host"] = publicHost;
  request.headers["x-forwarded-proto"] =
    forwardedProtocol === undefined ? "http" : forwardedProtocol;
  request.url = `${target.pathname}${target.search}`;
}

function removePrivateHeaders(headers: IncomingHttpHeaders) {
  delete headers["x-halo-extension-token"];
  delete headers["x-halo-viewer-token"];
  delete headers["x-halo-viewer-id"];
  delete headers["x-halo-viewer-role"];
  delete headers["x-halo-viewer-email"];
  delete headers.authorization;
  delete headers.cookie;
  delete headers.forwarded;
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
  delete headers["x-halo-public-host"];
  delete headers["x-halo-public-proto"];
  delete headers["x-exedev-authorization"];
  delete headers["x-exedev-token-ctx"];
  delete headers["x-exedev-userid"];
  delete headers["x-exedev-email"];
}

function firstHeader(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function respondToUpgrade(socket: Duplex, statusCode: number) {
  socket.end(
    `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode]}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n",
  );
}
