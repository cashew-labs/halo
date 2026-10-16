import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { DatabaseService } from "../DatabaseService.js";
import { AppStore } from "../apps/AppStore.js";

const storeTest = test.extend<{ store: AppStore }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  store: async ({}, use) => {
    const parent = path.resolve(
      import.meta.dirname,
      "../../../../tmp/published-app-deletion",
    );
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, "store-"));
    const db = await DatabaseService.start({
      type: "sqlite",
      path: path.join(directory, "db"),
    });
    if (db instanceof Error) throw db;
    const store = new AppStore({ db });
    const initialized = await store.initialize();
    if (initialized instanceof Error) throw initialized;
    await use(store);
    const closed = await db.close();
    if (closed instanceof Error) throw closed;
    await fs.rm(directory, { recursive: true });
  },
});

storeTest(
  "deletion and republishing cannot both claim an unpublished live app",
  async ({ store }) => {
    const handle = await store.ensureHandle({
      userId: "owner",
      email: "owner@example.test",
    });
    if (handle instanceof Error) throw handle;
    const app = await store.create({
      ownerUserId: "owner",
      extensionId: "delete-me",
      slug: "delete-me",
      displayName: "Delete me",
      visibility: "public",
      members: [],
      syncAccess: "read-only",
      actions: [],
    });
    if (app instanceof Error) throw app;
    expect(await store.beginRemoval(app.appId)).toBeInstanceOf(Error);
    const live = await store.advance({
      appId: app.appId,
      from: "frozen",
      to: "live",
    });
    if (live instanceof Error) throw live;
    // A still-published app is refused even when the service's earlier read was stale.
    expect(await store.beginRemoval(app.appId)).toBeInstanceOf(Error);
    const unshared = await store.updateAccess({
      appId: app.appId,
      published: false,
    });
    if (unshared instanceof Error) throw unshared;
    const outcomes = await Promise.all([
      store.beginRemoval(app.appId),
      store.updateAccess({ appId: app.appId, published: true }),
    ]);
    expect(outcomes.filter((outcome) => outcome instanceof Error)).toHaveLength(
      1,
    );
    expect(await store.get(app.appId)).toMatchObject({
      stage: "removing",
      published: false,
    });
    expect(await store.beginRemoval(app.appId)).toMatchObject({
      stage: "removing",
      credentialGeneration: 2,
    });
  },
);
