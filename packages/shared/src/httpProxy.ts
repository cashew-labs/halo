import http, {
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";
import type { Duplex } from "node:stream";
import * as errore from "errore";

export class HttpProxyError extends errore.createTaggedError({
  name: "HttpProxyError",
  message: "HTTP proxy failed",
}) {}

export async function proxyWebSocketUpgrade(ctx: {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  target: URL;
  headers: OutgoingHttpHeaders;
}) {
  return await new Promise<HttpProxyError | undefined>(
    (resolve) => {
      const upstreamRequest = http.request(ctx.target, {
        method: ctx.request.method,
        headers: ctx.headers,
      });
      upstreamRequest.once(
        "upgrade",
        (response, upstreamSocket, upstreamHead) => {
          writeResponseHead(ctx.socket, response);
          if (ctx.head.byteLength > 0) upstreamSocket.write(ctx.head);
          if (upstreamHead.byteLength > 0) ctx.socket.write(upstreamHead);

          ctx.socket.once("error", () => upstreamSocket.destroy());
          upstreamSocket.once("error", () => ctx.socket.destroy());
          ctx.socket.once("close", () => upstreamSocket.destroy());
          upstreamSocket.once("close", () => ctx.socket.destroy());
          ctx.socket.pipe(upstreamSocket);
          upstreamSocket.pipe(ctx.socket);
          resolve(undefined);
        },
      );
      upstreamRequest.once("response", (response) => {
        writeResponseHead(ctx.socket, response);
        response.pipe(ctx.socket);
        response.once("end", () => resolve(undefined));
      });
      upstreamRequest.once("error", (cause) => {
        if (!ctx.socket.destroyed) respondToWebSocketUpgrade(ctx.socket, 502);
        resolve(new HttpProxyError({ cause }));
      });
      ctx.socket.once("close", () => upstreamRequest.destroy());
      upstreamRequest.end();
    },
  );
}

export function respondToWebSocketUpgrade(socket: Duplex, statusCode: number) {
  socket.end(
    `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode]}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n",
  );
}

function writeResponseHead(socket: Duplex, response: IncomingMessage) {
  const statusMessage =
    response.statusMessage === undefined ? "" : ` ${response.statusMessage}`;
  const statusLine = `HTTP/${response.httpVersion} ${response.statusCode}${statusMessage}\r\n`;
  const headers: string[] = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    headers.push(
      `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`,
    );
  }
  socket.write(`${statusLine}${headers.join("")}\r\n`);
}
