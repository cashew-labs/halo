import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { RPCHandler } from "@orpc/server/node";
import {
  appControlFilePath,
  type AppControlConnection,
} from "@get-halo/app-control";
import * as errore from "errore";
import {
  AppControlService,
  type AppBrowserTarget,
} from "./AppControlService.js";
import { appRouter } from "./appRouter.js";

class AppControlServerError extends errore.createTaggedError({
  name: "AppControlServerError",
  message: "Halo app-control server failed: $detail",
}) {}

// oxlint-disable-next-line anti-slop/no-unused-exports -- main.ts loads this through a dev-only dynamic import.
export class AppControlServer {
  private readonly server: http.Server;
  private readonly connectionPath: string;

  private constructor(ctx: { server: http.Server; connectionPath: string }) {
    const { server, connectionPath } = ctx;
    this.server = server;
    this.connectionPath = connectionPath;
  }

  static async start(ctx: { target: AppBrowserTarget; appDataDir: string }) {
    const { target, appDataDir } = ctx;
    const token = crypto.randomBytes(32).toString("base64url");
    const appControl = new AppControlService({
      target,
      screenshotDirectory: path.join(appDataDir, "app", "screenshots"),
    });
    const handler = new RPCHandler(appRouter);
    const server = http.createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      const handled = await handler.handle(request, response, {
        prefix: "/rpc",
        context: { appControl },
      });
      if (!handled.matched) response.writeHead(404).end();
    });
    const listening = await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    }).catch((cause) => new AppControlServerError({ detail: "listen", cause }));
    if (listening instanceof Error) return listening;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const closed = await closeServer(server);
      if (closed instanceof Error) console.error(closed);
    });
    // SAFETY: A successful TCP listen returns an AddressInfo.
    const address = server.address() as AddressInfo;
    const connection: AppControlConnection = {
      version: 1,
      port: address.port,
      token,
    };
    const connectionPath = appControlFilePath(appDataDir);
    const written = await fs
      .writeFile(connectionPath, `${JSON.stringify(connection)}\n`, {
        mode: 0o600,
      })
      .catch(
        (cause) =>
          new AppControlServerError({ detail: "write appControl.json", cause }),
      );
    if (written instanceof Error) return written;
    cleanup.move();
    return new AppControlServer({ server, connectionPath });
  }

  async close() {
    const removed = await fs.rm(this.connectionPath, { force: true }).catch(
      (cause) =>
        new AppControlServerError({
          detail: "remove appControl.json",
          cause,
        }),
    );
    const closed = await closeServer(this.server);
    if (removed instanceof Error) return removed;
    return closed;
  }
}

async function closeServer(server: http.Server) {
  return await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  }).catch((cause) => new AppControlServerError({ detail: "close", cause }));
}
