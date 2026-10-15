import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { DatabaseService } from "../../DatabaseService.js";
import { AppStore } from "../AppStore.js";

test("the app store guards handles, stage transitions and stored actions", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/control-plane");
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, "store-"));
  const db = await DatabaseService.start({ type: "sqlite", path: path.join(directory, "control-plane.db") });
  if (db instanceof Error) throw db;
  try {
    const store = new AppStore({ db });
    expect(await store.initialize()).toBeUndefined();
    // Handles avoid reserved names and run out after 99 suffixes.
    expect(await store.ensureHandle({ userId: "admin-user", email: "admin@example.com" })).toBe("admin-2");
    expect(await store.ensureHandle({ userId: "digits", email: "42@example.com" })).toBe("u-42");
    expect(await store.ensureHandle({ userId: "symbols", email: "+++@example.com" })).toBe("creator");
    for (let index = 0; index < 99; index += 1) expect(await store.ensureHandle({ userId: `same-${index}`, email: "same@example.com" })).toBe(index === 0 ? "same" : `same-${index + 1}`);
    expect(await store.ensureHandle({ userId: "one-too-many", email: "same@example.com" })).toBeInstanceOf(Error);
    const app = await store.create({ ownerUserId: "digits", extensionId: "books", slug: "books", displayName: "Books", visibility: "public", members: [], syncAccess: "read-only", actions: [] });
    if (app instanceof Error) throw app;
    // Steps advance only from the stage the caller saw.
    expect(await store.advance({ appId: app.appId, from: "ready", to: "live" })).toBeInstanceOf(Error);
    expect(await store.advance({ appId: app.appId, from: "frozen", to: "ready" })).toMatchObject({ stage: "ready" });
    expect(await store.define({ appId: app.appId, displayName: "Books", syncAccess: "shared", actions: [] })).toBeInstanceOf(Error);
    // A corrupt stored action fails closed instead of running something else.
    using database = new DatabaseSync(path.join(directory, "control-plane.db.apps"));
    database.prepare("INSERT INTO app_actions (app_id, name, description, address, arguments) VALUES (?, 'x', 'x', 'a.b.c', '{')").run(app.appId);
    expect(await store.actions(app.appId)).toBeInstanceOf(Error);
    // Concurrent redemptions of one code yield exactly one session.
    const state = "s".repeat(43);
    const code = await store.createHandoff({ handle: "u-42", state, userId: "digits", email: "42@example.com" });
    if (code instanceof Error) throw code;
    expect(await store.redeemHandoff({ handle: "u-42", code, state: "t".repeat(43) })).toBeUndefined();
    const redeemed = await Promise.all(Array.from({ length: 5 }, async () => await store.redeemHandoff({ handle: "u-42", code, state })));
    expect(redeemed.filter((token) => typeof token === "string")).toHaveLength(1);
    expect(redeemed.filter((token) => token === undefined)).toHaveLength(4);
  } finally {
    await db.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
