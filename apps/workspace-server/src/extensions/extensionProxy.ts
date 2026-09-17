import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import {
  proxyWebSocketUpgrade,
  respondToWebSocketUpgrade,
} from "@get-halo/shared/httpProxy";
import * as errore from "errore";
import type { ExtensionHost } from "./ExtensionHost.js";

const extensionPathPrefix = "/extensions/";
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
    respondToWebSocketUpgrade(ctx.socket, 400);
    return;
  }

  const origin = ctx.extensions.getOrigin(route.id);
  if (origin === undefined) {
    respondToWebSocketUpgrade(ctx.socket, 404);
    return;
  }

  const target = new URL(`${route.path}${ctx.url.search}`, origin);
  const headers = forwardedRequestHeaders(ctx.request.headers, target.host);
  headers.connection = "Upgrade";
  headers.upgrade = ctx.request.headers.upgrade;
  const proxied = await proxyWebSocketUpgrade({ ...ctx, target, headers });
  if (proxied instanceof Error) {
    console.error(
      new ExtensionProxyError({
        detail: "WebSocket upgrade",
        cause: proxied,
      }),
    );
  }
  return proxied;
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
  await new Promise<void>((resolve) => {
    const upstreamRequest = http.request(
      ctx.target,
      {
        method: ctx.request.method,
        headers: forwardedRequestHeaders(ctx.request.headers, ctx.target.host),
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
      console.error(new ExtensionProxyError({ detail: "request", cause }));
      if (!ctx.response.headersSent) ctx.response.writeHead(502);
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

function forwardedRequestHeaders(incoming: IncomingHttpHeaders, host: string) {
  const headers = forwardedHeaders(incoming);
  delete headers.authorization;
  delete headers.cookie;
  delete headers.forwarded;
  const forwardedProtocol = firstHeader(incoming["x-forwarded-proto"]);
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
  headers.host = host;
  headers["x-forwarded-host"] = incoming.host;
  headers["x-forwarded-proto"] =
    forwardedProtocol === undefined ? "http" : forwardedProtocol;
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

function firstHeader(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}
