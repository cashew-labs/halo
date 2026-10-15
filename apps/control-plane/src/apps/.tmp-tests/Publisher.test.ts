import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DatabaseService } from "../../DatabaseService.js";
import { AppStore } from "../AppStore.js";

const storeTest = test.extend<{ store: AppStore }>({
  store: async ({ task }, use) => {
    const directory = await mkdtemp(
      resolve(import.meta.dirname, "../../../../../tmp/publisher-url/db-"),
    );
    const db = await DatabaseService.start({
      type: "sqlite",
      path: join(directory, task.id),
    });
    if (db instanceof Error) throw db;
    const store = new AppStore({ db });
    expect(await store.initialize()).toBeUndefined();
    await use(store);
    await db.close();
    await rm(directory, { recursive: true, force: true });
  },
});

storeTest(
  "rename preserves apps and invalidates credentials before the old handle is reassigned",
  async ({ store }) => {
    const old = await store.ensureHandle({
      userId: "alice",
      email: "alice@example.test",
    });
    if (old instanceof Error) throw old;
    const app = await store.create({
      ownerUserId: "alice",
      extensionId: "notes",
      slug: "notes",
      displayName: "Notes",
      visibility: "invited",
      members: ["viewer@example.test"],
      syncAccess: "shared",
      actions: [],
    });
    if (app instanceof Error) throw app;
    const code = await store.createHandoff({
      handle: old,
      state: "state",
      userId: "viewer",
      email: "viewer@example.test",
    });
    if (code instanceof Error) throw code;
    const token = await store.redeemHandoff({
      handle: old,
      state: "state",
      code,
    });
    if (token instanceof Error || token === undefined)
      throw new Error("missing session");
    const pending = await store.createHandoff({
      handle: old,
      state: "pending",
      userId: "viewer",
      email: "viewer@example.test",
    });
    if (pending instanceof Error) throw pending;
    expect(await store.findViewerSession({ handle: old, token })).toMatchObject(
      { userId: "viewer" },
    );
    expect(
      await store.renameHandle({ userId: "alice", handle: "new-alice" }),
    ).toBe("new-alice");
    expect(
      await store.findByAddress({ handle: old, slug: "notes" }),
    ).toBeUndefined();
    expect(
      await store.findByAddress({ handle: "new-alice", slug: "notes" }),
    ).toEqual({ ...app, handle: "new-alice" });
    expect(
      await store.createHandoff({
        handle: old,
        state: "gone",
        userId: "viewer",
        email: "viewer@example.test",
      }),
    ).toBeInstanceOf(Error);
    expect(
      await store.redeemHandoff({
        handle: old,
        code: pending,
        state: "pending",
      }),
    ).toBeInstanceOf(Error);
    expect(await store.renameHandle({ userId: "bob", handle: old })).toBe(old);
    expect(
      await store.findViewerSession({ handle: old, token }),
    ).toBeUndefined();
    expect(
      await store.redeemHandoff({
        handle: old,
        code: pending,
        state: "pending",
      }),
    ).toBeUndefined();
    expect(
      await store.findViewerSession({ handle: "new-alice", token }),
    ).toBeUndefined();
    const fresh = await store.createHandoff({
      handle: old,
      state: "fresh",
      userId: "bob",
      email: "bob@example.test",
    });
    expect(fresh).toBeTypeOf("string");
  },
);

storeTest(
  "claims one handle under concurrent writes and keeps failed rename state intact",
  async ({ store }) => {
    const claims = await Promise.all(
      ["one", "two"].map((userId) =>
        store.renameHandle({ userId, handle: "same" }),
      ),
    );
    expect(claims.filter((claim) => claim instanceof Error)).toHaveLength(1);
    expect(
      await store.ensureHandle({ userId: "third", email: "same@example.test" }),
    ).toBe("same-2");
    expect(
      await store.renameHandle({ userId: "third", handle: "same" }),
    ).toBeInstanceOf(Error);
    expect(
      await store.ensureHandle({
        userId: "third",
        email: "ignored@example.test",
      }),
    ).toBe("same-2");
    expect(
      await store.checkHandle({ userId: "third", handle: "same-2" }),
    ).toMatchObject({ available: true });
    expect(
      await store.checkHandle({ userId: "third", handle: "same" }),
    ).toMatchObject({ available: false });
  },
);
