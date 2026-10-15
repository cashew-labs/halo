import { test, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DatabaseService } from "../../DatabaseService.js";
import { AppStore } from "../AppStore.js";

const storeTest = test.extend<{ store: AppStore }>({
  store: async ({ task }, use) => {
    const parent = resolve(import.meta.dirname, "../../../../../tmp/publisher-url");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "db-"));
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
    // An unknown or renamed creator has no host to sign in to: not an outage.
    expect(
      await store.createHandoff({ handle: old, state: "gone", userId: "viewer", email: "viewer@example.test" }),
    ).toBeUndefined();
    expect(await store.redeemHandoff({ handle: old, code: pending, state: "pending" })).toBeUndefined();
    // The released handle stays reserved for its previous owner.
    expect(await store.renameHandle({ userId: "bob", handle: old })).toBeInstanceOf(Error);
    expect(await store.checkHandle({ userId: "bob", handle: old })).toMatchObject({ available: false });
    expect(await store.checkHandle({ userId: "alice", handle: old })).toMatchObject({ available: true });
    expect(await store.ensureHandle({ userId: "carol", email: `${old}@example.test` })).toBe(`${old}-2`);
    // The previous owner can return to it; old sessions and handoffs stay invalid.
    expect(await store.renameHandle({ userId: "alice", handle: old })).toBe(old);
    expect(await store.findViewerSession({ handle: old, token })).toBeUndefined();
    expect(await store.redeemHandoff({ handle: old, code: pending, state: "pending" })).toBeUndefined();
    expect(await store.findViewerSession({ handle: "new-alice", token })).toBeUndefined();
    // Alice's own earlier handle is now reserved for her too.
    expect(await store.renameHandle({ userId: "bob", handle: "new-alice" })).toBeInstanceOf(Error);
    const fresh = await store.createHandoff({ handle: old, state: "fresh", userId: "viewer", email: "viewer@example.test" });
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

storeTest(
  "limits how many handles one account reserves and lets it return to its own",
  async ({ store }) => {
    expect(await store.ensureHandle({ userId: "dana", email: "dana@example.test" })).toBe("dana");
    for (let index = 1; index < 20; index += 1)
      expect(await store.renameHandle({ userId: "dana", handle: `dana-${index}` })).toBe(`dana-${index}`);
    expect(await store.renameHandle({ userId: "dana", handle: "dana-new" })).toBeInstanceOf(Error);
    expect(await store.renameHandle({ userId: "dana", handle: "dana" })).toBe("dana");
    // Initializing again keeps every claim; existing creators are claimed once.
    expect(await store.initialize()).toBeUndefined();
    expect(await store.checkHandle({ userId: "erin", handle: "dana-5" })).toMatchObject({ available: false });
  },
);

test("creator rows written without a claim keep their handle and are claimed on startup", async () => {
  const parent = resolve(import.meta.dirname, "../../../../../tmp/publisher-url");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "legacy-"));
  const path = join(directory, "control-plane.db");
  const db = await DatabaseService.start({ type: "sqlite", path });
  if (db instanceof Error) throw db;
  try {
    // A creator row from before claims existed.
    {
      using raw = new DatabaseSync(`${path}.apps`);
      raw.exec("CREATE TABLE IF NOT EXISTS app_creators (user_id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE)");
      raw.prepare("INSERT INTO app_creators (user_id, handle) VALUES (?, ?)").run("old-creator", "legacy");
    }
    const store = new AppStore({ db });
    expect(await store.initialize()).toBeUndefined();
    expect(await store.checkHandle({ userId: "someone", handle: "legacy" })).toMatchObject({ available: false });
    // A row an older instance writes during a deploy, without a claim, still holds its handle.
    {
      using raw = new DatabaseSync(`${path}.apps`);
      raw.prepare("INSERT INTO app_creators (user_id, handle) VALUES (?, ?)").run("deploying-creator", "fresh");
    }
    expect(await store.renameHandle({ userId: "someone", handle: "fresh" })).toMatchObject({ message: expect.stringContaining("already taken") });
    expect(await store.ensureHandle({ userId: "newcomer", email: "fresh@example.test" })).toBe("fresh-2");
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
