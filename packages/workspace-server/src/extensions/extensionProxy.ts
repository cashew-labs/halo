import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { respondToHttpUpgrade } from "@get-halo/shared/httpUpgrade";
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
    respondToHttpUpgrade(ctx.socket, 400);
    return;
  }

  const origin = ctx.extensions.getOrigin(route.id);
  if (origin === undefined) {
    respondToHttpUpgrade(ctx.socket, 404);
    return;
  }

  const target = new URL(`${route.path}${ctx.url.search}`, origin);
  prepareRequest(ctx.request, target);
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
