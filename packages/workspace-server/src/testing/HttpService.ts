import http from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter, once } from "node:events";
import * as errore from "errore";

class HttpServiceError extends errore.createTaggedError({
  name: "HttpServiceError",
  message: "Test HTTP service failed: $operation",
}) {}

export class HttpService {
  private readonly requests = new Map<string, http.ServerResponse>();
  private readonly incoming = new EventEmitter();

  private constructor(private readonly server: http.Server) {
    server.on("request", (request, response) => {
      this.requests.set(request.url!, response);
      this.incoming.emit("request");
    });
  }

  static async start() {
    const server = http.createServer();
    const service = new HttpService(server);
    server.listen({ host: "127.0.0.1", port: 0 });
    const listening = await once(server, "listening").catch(
      (cause) => new HttpServiceError({ operation: "listen", cause }),
    );
    if (listening instanceof Error) return listening;
    return service;
  }

  url(path: string) {
    // SAFETY: start() waits for this TCP server to listen.
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}${path}`;
  }

  async request(path: string) {
    while (!this.requests.has(path)) {
      const received = await once(this.incoming, "request", {
        signal: AbortSignal.timeout(10_000),
      }).catch(
        (cause) =>
          new HttpServiceError({ operation: `wait for ${path}`, cause }),
      );
      if (received instanceof Error) throw received;
    }
    const response = this.requests.get(path)!;
    this.requests.delete(path);
    return {
      respond(
        text: string,
        options?: { contentType?: string; status?: number },
      ) {
        response.writeHead(
          options?.status === undefined ? 200 : options.status,
          {
            "Content-Type":
              options?.contentType === undefined
                ? "text/plain"
                : options.contentType,
          },
        );
        response.end(text);
      },
    };
  }

  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => {
        if (error !== undefined) return reject(error);
        resolve();
      }),
    );
  }
}
