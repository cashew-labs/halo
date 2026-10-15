import { parseArgs } from "node:util";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { RPCHandler } from "@orpc/server/node";
import type { AnyRouter } from "@orpc/server";
import type {
  AnyRelations,
  AnySchema,
  RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core";
import {
  TandemServer,
  TandemServerJsonFileStorage,
} from "@tanishqkancharla/tandem-server";
import * as errore from "errore";
import { syncRouter } from "./sync.js";
import { createExtensionTools, type ExtensionViewer } from "./tools.js";

class ExtensionServerError extends errore.createTaggedError({
  name: "ExtensionServerError",
  message: "Extension server failed: $operation",
}) {}

// Human events inside a separate-origin frame do not bubble to Halo's document.
const activityScript = `<script>
  let lastActivity = 0;
  for (const event of ["pointermove", "pointerdown", "keydown", "wheel"]) {
    document.addEventListener(event, () => {
      if (Date.now() - lastActivity < 1000) return;
      lastActivity = Date.now();
      window.parent.postMessage({ type: "halo:user-activity" }, "*");
    }, { passive: true, capture: true });
  }
</script>`;

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
  Schema extends AnySchema,
  Relations extends AnyRelations<Schema>,
>(args: {
  router: AnyRouter;
  schema: RuntimeSchemaDefinition<Schema>;
  relations: Relations;
  publicDirectory: string;
  dataDirectory: string;
  port: number;
  hostToken?: string;
  host?: string;
  syncAccess?: "read-only" | "shared" | "actions";
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
        body:
          file === "index.html"
            ? Buffer.from(
                body.toString().replace("</head>", `${activityScript}</head>`),
              )
            : body,
        contentType,
      },
    );
  }
  const storage = new TandemServerJsonFileStorage<Schema>({
    filePath: join(args.dataDirectory, "tandem.json"),
  });
  const tandem = new TandemServer({
    schema: args.schema,
    relations: args.relations,
    storage,
  });
  const apiHandler = new RPCHandler(args.router);
  const tools = createExtensionTools();
  const syncHandler = new RPCHandler(syncRouter(tandem));
  const server = createServer(async (request, response) => {
    if (args.hostToken !== undefined) {
      const supplied = request.headers["x-halo-extension-token"];
      const actual = Buffer.from(
        Array.isArray(supplied) ? "" : (supplied ?? ""),
      );
      const expected = Buffer.from(args.hostToken);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        response.writeHead(401).end();
        return;
      }
    }
    const viewer: ExtensionViewer = {
      viewerId: Array.isArray(request.headers["x-halo-viewer-id"])
        ? "owner"
        : (request.headers["x-halo-viewer-id"] ?? "owner"),
      // Behind Halo's proxy every request names its role, so anything else is
      // public. A standalone preview has no proxy and serves its owner.
      role:
        request.headers["x-halo-viewer-role"] === "owner"
          ? "owner"
          : request.headers["x-halo-viewer-role"] === "member"
            ? "member"
            : request.headers["x-halo-viewer-role"] === "public" ||
                args.hostToken !== undefined
              ? "public"
              : "owner",
      email: Array.isArray(request.headers["x-halo-viewer-email"])
        ? undefined
        : request.headers["x-halo-viewer-email"],
    };
    if (request.url === "/__halo/ready") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ protocol: 1 }));
      return;
    }
    const syncAccess = args.syncAccess;
    const handled = await apiHandler.handle(request, response, {
      prefix: "/api",
      context: { tools, viewer, storage: tandem },
    });
    if (handled.matched) return;
    const synced = await syncHandler.handle(request, response, {
      prefix: "/sync",
      context: {
        canRead: viewer.role === "owner" || syncAccess !== "actions",
        canWrite: viewer.role === "owner" || syncAccess === "shared",
      },
    });
    if (synced.matched) return;
    const pathname = new URL(request.url!, "http://localhost").pathname;
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
      server.listen(args.port, args.host ?? "127.0.0.1", () =>
        resolve(undefined),
      );
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
  Schema extends AnySchema,
  Relations extends AnyRelations<Schema>,
>(args: {
  router: AnyRouter;
  schema: RuntimeSchemaDefinition<Schema>;
  relations: Relations;
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
    hostToken: process.env.HALO_EXTENSION_HOST_TOKEN,
    host: process.env.HALO_EXTENSION_LISTEN_HOST,
    syncAccess:
      process.env.HALO_EXTENSION_SYNC_ACCESS === "shared"
        ? "shared"
        : process.env.HALO_EXTENSION_SYNC_ACCESS === "actions"
          ? "actions"
          : "read-only",
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
