import dns from "node:dns/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { DatabaseService } from "../../DatabaseService.js";
import { AppStore } from "../AppStore.js";
import { creatorHandle } from "../creatorHost.js";
import { AppDomains, type AppDomainTls } from "../AppDomains.js";
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    default: { ...actual.default, resolveTxt: vi.fn(actual.resolveTxt) },
  };
});
const domainTest = test.extend<{ apps: AppStore; appId: string }>({
  // oxlint-disable-next-line no-empty-pattern -- Native fixture callback.
  apps: async ({}, use) => {
    const root = await fs.mkdtemp(
      path.resolve(import.meta.dirname, "../../../../../tmp/domain-boundary-"),
    );
    const db = await DatabaseService.start({
      type: "sqlite",
      path: path.join(root, "db"),
    });
    if (db instanceof Error) throw db;
    try {
      const apps = new AppStore({ db });
      const initialized = await apps.initialize();
      if (initialized instanceof Error) throw initialized;
      await use(apps);
    } finally {
      await db.close();
      await fs.rm(root, { recursive: true, force: true });
      vi.mocked(dns.resolveTxt).mockReset();
    }
  },
  appId: async ({ apps }, use) => {
    const handle = await apps.ensureHandle({
      userId: "owner",
      email: "owner@example.org",
    });
    if (handle instanceof Error) throw handle;
    const app = await apps.create({
      ownerUserId: "owner",
      extensionId: "links",
      slug: "links",
      displayName: "Links",
      visibility: "public",
      members: [],
      syncAccess: "read-only",
      actions: [],
    });
    if (app instanceof Error) throw app;
    const live = await apps.advance({
      appId: app.appId,
      from: "frozen",
      to: "live",
    });
    if (live instanceof Error) throw live;
    await use(app.appId);
  },
});
const tls: AppDomainTls = {
  ensure: async () => ({ ready: true, records: [] }),
  remove: async () => {},
  routingRecords: () => [],
};
domainTest(
  "refuses unconfigured hosting and Halo-reserved names",
  async ({ apps, appId }) => {
    const input = {
      ownerUserId: "owner",
      appId,
      hostname: "links.example.org",
    };
    expect(
      creatorHandle({
        publicOrigin: "https://gethalo.dev",
        host: "go.gethalo.dev",
      }),
    ).toBeUndefined();
    expect(
      creatorHandle({
        publicOrigin: "https://gethalo.dev",
        host: "alice.gethalo.dev",
      }),
    ).toBe("alice");
    const disabled = new AppDomains({
      database: apps.database,
      apps,
      publicOrigin: "https://gethalo.dev",
    });
    await disabled.initialize();
    expect(await disabled.add(input)).toMatchObject({
      name: "AppDomainRequestError",
    });
    const enabled = new AppDomains({
      database: apps.database,
      apps,
      publicOrigin: "https://gethalo.dev",
      tls,
    });
    for (const hostname of [
      "gethalo.dev",
      "alice.gethalo.dev",
      "www.gethalo.dev",
    ])
      expect(await enabled.add({ ...input, hostname })).toMatchObject({
        name: "AppDomainRequestError",
      });
    expect(
      await enabled.add({ ...input, hostname: "GO.GETHALO.DEV." }),
    ).toMatchObject({ hostname: "go.gethalo.dev", status: "pending" });
  },
);
domainTest(
  "handles native DNS absence and failures before TLS provisioning",
  async ({ apps, appId }) => {
    const domains = new AppDomains({
      database: apps.database,
      apps,
      publicOrigin: "https://gethalo.dev",
      tls,
    });
    await domains.initialize();
    const input = { ownerUserId: "owner", appId, hostname: "dns.example.org" };
    const added = await domains.add(input);
    if (added instanceof Error) throw added;
    for (const code of ["ENODATA", "ENOTFOUND", "ETIMEOUT"]) {
      vi.mocked(dns.resolveTxt).mockRejectedValueOnce(
        Object.assign(new Error("DNS failed"), { code }),
      );
      expect(await domains.verify(input)).toMatchObject({
        name:
          code === "ETIMEOUT" ? "AppDomainHostError" : "AppDomainRequestError",
      });
    }
    const proof = added.records.find((record) => record.type === "TXT")!;
    vi.mocked(dns.resolveTxt).mockResolvedValueOnce([[proof.value]]);
    const disabled = new AppDomains({
      database: apps.database,
      apps,
      publicOrigin: "https://gethalo.dev",
    });
    expect(await disabled.verify(input)).toMatchObject({
      name: "AppDomainRequestError",
    });
  },
);

domainTest(
  "keeps a live binding active during re-verification",
  async ({ apps, appId }) => {
    const domains = new AppDomains({
      database: apps.database,
      apps,
      publicOrigin: "https://gethalo.dev",
      tls,
    });
    await domains.initialize();
    const input = { ownerUserId: "owner", appId, hostname: "live.example.org" };
    const added = await domains.add(input);
    if (added instanceof Error) throw added;
    const proof = added.records.find((record) => record.type === "TXT")!;
    vi.mocked(dns.resolveTxt).mockResolvedValue([[proof.value]]);
    expect(await domains.verify(input)).toMatchObject({ status: "active" });
    // A live verification must not write an intermediate inactive route, even briefly.
    const trigger = await apps.database.query(
      "CREATE TRIGGER keep_live BEFORE UPDATE OF active ON app_domains WHEN OLD.active=1 AND NEW.active=0 BEGIN SELECT RAISE(ABORT, 'live route interrupted'); END",
    );
    if (trigger instanceof Error) throw trigger;
    expect(await domains.verify(input)).toMatchObject({ status: "active" });
    const found = await domains.lookup(input.hostname);
    if (found instanceof Error) throw found;
    expect(found?.appId).toBe(appId);
  },
);
