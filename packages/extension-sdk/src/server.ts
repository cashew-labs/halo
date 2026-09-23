import { parseArgs } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { RPCHandler } from "@orpc/server/node";
import type { AnyRelations, AnySchema } from "@tanishqkancharla/tandem-core";
import {
  TandemServer,
  TandemServerJsonFileStorage,
} from "@tanishqkancharla/tandem-server";
import * as errore from "errore";
import { syncRouter } from "./sync.js";
import { createExtensionTools } from "./tools.js";
import type { AnyExtensionApi, ExtensionDefinition } from "./definition.js";
export {
  defineExtension,
  reactView,
  type ExtensionDefinition,
  type ExtensionEnvironment,
  type ReactExtensionView,
} from "./definition.js";

class ExtensionServerError extends errore.createTaggedError({
  name: "ExtensionServerError",
  message: "Extension server failed: $operation",
}) {}

const contentTypes = new Map(
  Object.entries({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  }),
);

export async function serveExtension<
  Api extends AnyExtensionApi,
  Schema extends AnySchema,
  Relations extends AnyRelations<Schema>,
>(args: {
  extension: ExtensionDefinition<Api, Schema, Relations>;
  publicDirectory: string;
  dataDirectory: string;
  port: number;
}) {
  const files = await readdir(args.publicDirectory).catch(
    (cause) => new ExtensionServerError({ operation: "read assets", cause }),
  );
  if (files instanceof Error) return files;
  const assets = new Map<string, { body: Buffer; contentType: string }>();
  for (const file of files) {
    const body = await readFile(join(args.publicDirectory, file)).catch(
      (cause) => new ExtensionServerError({ operation: "read asset", cause }),
    );
    if (body instanceof Error) return body;
    const contentType = contentTypes.get(extname(file));
    if (contentType === undefined)
      return new ExtensionServerError({
        operation: `unsupported asset ${file}`,
      });
    assets.set(
      file === "index.html"
        ? "/view/"
        : `/view/assets/${encodeURIComponent(file)}`,
      {
        body,
        contentType,
      },
    );
  }
  const storage = new TandemServerJsonFileStorage<Schema>({
    filePath: join(args.dataDirectory, "tandem.json"),
  });
  const tandem = new TandemServer({
    schema: args.extension.schema,
    relations: args.extension.relations,
    storage,
  });
  const tools = createExtensionTools();
  const apiHandler = getRequestListener(
    async (request) => await args.extension.api.fetch(request, { tools }),
  );
  const syncHandler = new RPCHandler(syncRouter(tandem));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const apiPath = url.pathname.slice("/api".length);
      request.url = `${apiPath === "" ? "/" : apiPath}${url.search}`;
      await apiHandler(request, response);
      return;
    }
    const synced = await syncHandler.handle(request, response, {
      prefix: "/sync",
      context: {},
    });
    if (synced.matched) return;
    const pathname = url.pathname;
    const isView =
      pathname.startsWith("/view/") && !pathname.startsWith("/view/assets/");
    const asset = assets.get(isView ? "/view/" : pathname);
    if (asset === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": asset.contentType });
    response.end(asset.body);
  });
  const started = await new Promise<undefined | ExtensionServerError>(
    (resolve) => {
      server.once("error", (cause) =>
        resolve(new ExtensionServerError({ operation: "listen", cause })),
      );
      server.listen(args.port, "127.0.0.1", () => resolve(undefined));
    },
  );
  if (started instanceof Error) return started;
  // SAFETY: a successful numeric TCP listen returns AddressInfo.
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/view/`,
    async close() {
      server.closeAllConnections();
      const closed = await new Promise<undefined | ExtensionServerError>(
        (resolve) => {
          server.close((cause) =>
            resolve(
              cause === undefined
                ? undefined
                : new ExtensionServerError({ operation: "close", cause }),
            ),
          );
        },
      );
      if (closed instanceof Error) return closed;
      return await tandem
        .close()
        .catch(
          (cause) =>
            new ExtensionServerError({ operation: "close Tandem", cause }),
        );
    },
  };
}

export async function runExtension<
  Api extends AnyExtensionApi,
  Schema extends AnySchema,
  Relations extends AnyRelations<Schema>,
>(args: {
  extension: ExtensionDefinition<Api, Schema, Relations>;
  publicDirectory: string;
}) {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "3000" },
      "data-dir": { type: "string", default: ".extension-data" },
    },
  });
  const running = await serveExtension({
    ...args,
    port: Number(values.port),
    dataDirectory: values["data-dir"],
  });
  if (running instanceof Error) {
    console.error(running);
    process.exitCode = 1;
    return;
  }
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async () => {
    if (shutdownPromise === undefined) {
      shutdownPromise = running.close().then((closed) => {
        if (closed instanceof Error) {
          console.error(closed);
          process.exitCode = 1;
        }
        if (process.connected) process.disconnect();
      });
    }
    return await shutdownPromise;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  if (process.send !== undefined) {
    process.on("message", async (message) => {
      if (message === "shutdown") await shutdown();
    });
    process.once("disconnect", shutdown);
    process.send(running.url, async (cause) => {
      if (cause === null) return;
      console.warn(
        new ExtensionServerError({ operation: "announce server", cause }),
      );
      await shutdown();
    });
  }
  console.log(`Listening on ${running.url}`);
}
