import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { readWorkspaceServerConnection } from "@get-halo/workspace-server/connection";
import * as errore from "errore";

class HaloWebHostError extends errore.createTaggedError({
  name: "HaloWebHostError",
  message: "Web host proxy failed: $detail",
}) {}

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

export function haloWebHostPlugin(): Plugin {
  const dataDir = process.env.HALO_USER_DATA;
  return {
    name: "halo-web-host",
    configureServer(server) {
      if (dataDir === undefined) return;
      server.middlewares.use((request, response, next) => {
        const url = new URL(
          request.url === undefined ? "/" : request.url,
          "http://localhost",
        );
        if (url.pathname === "/__halo/connection") {
          serveConnection({ dataDir, response }).catch((cause) => {
            console.error(
              new HaloWebHostError({ detail: "connection", cause }),
            );
            if (!response.headersSent) response.writeHead(500);
            if (!response.writableEnded) response.end();
          });
          return;
        }
        if (
          url.pathname === "/rpc" ||
          url.pathname.startsWith("/rpc/") ||
          url.pathname.startsWith("/extensions/")
        ) {
          proxyWorkspaceRequest({
            dataDir,
            request,
            response,
            url,
          }).catch((cause) => {
            console.error(new HaloWebHostError({ detail: "proxy", cause }));
            if (!response.headersSent) response.writeHead(502);
            if (!response.writableEnded) response.end();
          });
          return;
        }
        next();
      });
    },
  };
}

async function serveConnection(args: {
  dataDir: string;
  response: ServerResponse;
}) {
  const server = await readWorkspaceServerConnection(args.dataDir);
  if (server instanceof Error) {
    args.response.writeHead(500).end();
    return;
  }
  if (server === undefined) {
    args.response.writeHead(404).end();
    return;
  }
  args.response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ token: server.token }));
}

async function proxyWorkspaceRequest(args: {
  dataDir: string;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}) {
  const server = await readWorkspaceServerConnection(args.dataDir);
  if (server instanceof Error || server === undefined) {
    args.response.writeHead(502).end();
    return;
  }
  const target = new URL(
    `${args.url.pathname}${args.url.search}`,
    server.origin,
  );
  // Iframe document loads cannot send Authorization. Electron injects the
  // workspace token with webRequest; this proxy does the same for the browser.
  const authorization =
    args.request.headers.authorization === undefined
      ? `Bearer ${server.token}`
      : args.request.headers.authorization;
  await forwardRequest({
    request: args.request,
    response: args.response,
    target,
    authorization,
  });
}

async function forwardRequest(args: {
  authorization: string;
  request: IncomingMessage;
  response: ServerResponse;
  target: URL;
}) {
  await new Promise<void>((resolve) => {
    const headers = forwardedHeaders(args.request.headers);
    headers.host = args.target.host;
    headers.authorization = args.authorization;
    const upstreamRequest = http.request(
      args.target,
      {
        method: args.request.method,
        headers,
      },
      (upstreamResponse) => {
        const statusCode =
          upstreamResponse.statusCode === undefined
            ? 502
            : upstreamResponse.statusCode;
        args.response.writeHead(
          statusCode,
          forwardedHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(args.response);
        args.response.once("finish", resolve);
        args.response.once("close", () => {
          upstreamResponse.destroy();
          resolve();
        });
      },
    );
    upstreamRequest.once("error", (cause) => {
      console.error(new HaloWebHostError({ detail: "request", cause }));
      if (!args.response.headersSent) args.response.writeHead(502);
      if (!args.response.writableEnded) args.response.end();
      resolve();
    });
    args.request.once("aborted", () => {
      upstreamRequest.destroy();
      resolve();
    });
    args.request.pipe(upstreamRequest);
  });
}

function forwardedHeaders(incoming: http.IncomingHttpHeaders) {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || hopByHopHeaders.has(name.toLowerCase()))
      continue;
    headers[name] = value;
  }
  return headers;
}
