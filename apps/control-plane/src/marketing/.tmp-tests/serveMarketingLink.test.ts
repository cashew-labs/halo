import http from "node:http";
import events from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import * as errore from "errore";
import { DatabaseService } from "../../DatabaseService.js";
import { MarketingLinks } from "../MarketingLinks.js";
import { serveMarketingLink } from "../serveMarketingLink.js";

const resolverTest = test.extend<{ directory: string }>({
  directory: async ({ task }, use) => {
    const parent = path.resolve(
      import.meta.dirname,
      "../../../../../tmp/marketing-admin/resolver",
    );
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, `${task.id}-`));
    await use(directory);
    await fs.rm(directory, { recursive: true, force: true });
  },
});
resolverTest(
  "returns HTTP 500 rather than a missing campaign when the real database is closed",
  async ({ directory }) => {
    const db = await DatabaseService.start({
      type: "sqlite",
      path: path.join(directory, "control-plane.db"),
    });
    if (db instanceof Error) throw db;
    const links = new MarketingLinks({
      database: db.appDatabase,
      adminUserIds: [],
    });
    await links.initialize();
    await db.close();
    const server = http.createServer(async (request, response) => {
      await serveMarketingLink({
        request,
        response,
        homepageOrigin: "https://gethalo.dev",
        links,
      });
    });
    server.listen(0, "127.0.0.1");
    await events.once(server, "listening");
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    // SAFETY: The numeric listener has started.
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/launch`);
    expect(response.status).toBe(500);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  },
);
