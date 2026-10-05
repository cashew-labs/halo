import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createProxyServer, proxyUpgrade } from "httpxy";
import * as errore from "errore";

class DesktopProxyError extends errore.createTaggedError({
  name: "DesktopProxyError",
  message: "Desktop connection failed",
}) {}

export class DesktopProxy {
  private readonly proxy = createProxyServer();
  private readonly origin: string | undefined;

  constructor(ctx: { origin: string | undefined }) {
    this.origin = ctx.origin;
  }

  async serve(request: IncomingMessage, response: ServerResponse) {
    if (this.origin === undefined) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        "Desktop is unavailable. Connect to a Linux desktop workspace.",
      );
      return;
    }
    prepareDesktopRequest(request);
    const forwarded = await this.proxy
      .web(request, response, {
        target: this.origin,
        xfwd: false,
      })
      .catch((cause) => new DesktopProxyError({ cause }));
    if (forwarded instanceof Error) {
      console.error(forwarded);
      if (!response.headersSent) response.writeHead(502);
      if (!response.writableEnded)
        response.end("Desktop is starting. Reload to retry.");
    }
  }

  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    if (this.origin === undefined) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    prepareDesktopRequest(request);
    const forwarded = await proxyUpgrade(this.origin, request, socket, head, {
      xfwd: false,
    }).catch((cause) => new DesktopProxyError({ cause }));
    if (forwarded instanceof Error) {
      console.error(forwarded);
      socket.destroy();
    }
  }
}

function prepareDesktopRequest(request: IncomingMessage) {
  // Workspace authentication is complete; never forward its credentials to VNC.
  delete request.headers.authorization;
  delete request.headers.cookie;
  request.url = request.url?.slice("/desktop".length);
}
