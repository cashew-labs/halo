import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { os } from "../api.js";
import { serveExtension } from "../server.js";
import { connectExtension } from "../client.js";
import { defineSchema, defineRelations, collection, t } from "../schema.js";
import type { RouterClient } from "@orpc/server";
import type { syncRouter } from "../sync.js";

const extensionTest = test.extend<{ access: "actions" | "read-only" | "shared"; extension: { origin: string } }>({
  access: "actions",
  extension: async ({ access }, use) => {
    const root = path.resolve(import.meta.dirname, "../../../../tmp/extension-sharing");
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, "sdk-"));
    await fs.mkdir(path.join(directory, "public"));
    await fs.writeFile(path.join(directory, "public", "index.html"), "<html><head></head><body>Sample app</body></html>");
    const schema = defineSchema({ notes: collection({ id: t.id(), text: t.string() }) });
    const running = await serveExtension({ router: { viewer: os.handler(({ context }) => context.viewer), write: os.handler(async ({ context }) => { const tx = context.storage.transact(); tx.set("notes", { id: "sample", text: "hello" }); await context.storage.commit(tx); }) }, schema, relations: defineRelations(schema, () => ({})), publicDirectory: path.join(directory, "public"), dataDirectory: path.join(directory, "data"), port: 0, hostToken: "host-secret", syncAccess: access });
    if (running instanceof Error) throw running;
    await use({ origin: new URL(running.url).origin });
    await running.close();
    await fs.rm(directory, { recursive: true });
  },
});

extensionTest("hosted extension rejects unauthenticated access to assets, API and sync", async ({ extension }) => {
  for (const route of ["/view/", "/api/viewer", "/sync/pull", "/__halo/ready"])
    expect((await fetch(`${extension.origin}${route}`)).status).toBe(401);
  const headers = { "x-halo-extension-token": "host-secret" };
  expect(await (await fetch(`${extension.origin}/__halo/ready`, { headers })).json()).toEqual({ protocol: 1 });
  expect(await (await fetch(`${extension.origin}/view/`, { headers })).text()).toContain("Sample app");
});

extensionTest("actions-only visitors cannot bypass procedures using direct synchronization", async ({ extension }) => {
  const headers = { "x-halo-extension-token": "host-secret", "x-halo-viewer-id": "visitor", "x-halo-viewer-role": "public" };
  for (const route of ["/sync/pull", "/sync/push", "/sync/connect"])
    expect((await fetch(`${extension.origin}${route}`, { method: "POST", headers })).status).toBe(403);
});

const readOnlyTest = extensionTest.extend({ access: "read-only" });
const sharedTest = extensionTest.extend({ access: "shared" });
function syncClient(origin: string, role: string) {
  return createORPCClient<{ pull(input: { clientId: string; scanWindow: never[] }): Promise<{ patch: object }>; push(input: { clientId: string; mutations: never[] }): Promise<void> }>(new RPCLink({ origin, url: "/sync", headers: { "x-halo-extension-token": "host-secret", "x-halo-viewer-role": role } }));
}
readOnlyTest("read-only visitors pull but cannot push, including encoded procedure names", async ({ extension }) => {
  const client = syncClient(extension.origin, "public");
  expect(await client.pull({ clientId: "visitor", scanWindow: [] })).toHaveProperty("patch");
  await expect(client.push({ clientId: "visitor", mutations: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect((await fetch(`${extension.origin}/sync/%70ush`, { method: "POST", headers: { "x-halo-extension-token": "host-secret", "x-halo-viewer-role": "public" } })).status).toBe(403);
});
sharedTest("shared visitors and owners can push through authenticated sync", async ({ extension }) => {
  await expect(syncClient(extension.origin, "public").push({ clientId: "visitor", mutations: [] })).resolves.toBeUndefined();
});
extensionTest("owner retains sync and API exposes authenticated member identity", async ({ extension }) => {
  await expect(syncClient(extension.origin, "owner").push({ clientId: "owner", mutations: [] })).resolves.toBeUndefined();
  const api = createORPCClient<{ viewer(): Promise<{ viewerId: string; role: string; email?: string }> }>(new RPCLink({ origin: extension.origin, url: "/api", headers: { "x-halo-extension-token": "host-secret", "x-halo-viewer-id": "member-id", "x-halo-viewer-role": "member", "x-halo-viewer-email": "member@example.com" } }));
  expect(await api.viewer()).toEqual({ viewerId: "member-id", role: "member", email: "member@example.com" });
});

readOnlyTest("read-only sync connects, receives changes and closes on cancellation", async ({ extension }) => {
  const headers = { "x-halo-extension-token": "host-secret", "x-halo-viewer-role": "public" };
  const sync = createORPCClient<RouterClient<ReturnType<typeof syncRouter>>>(new RPCLink({ origin: extension.origin, url: "/sync", headers }));
  const controller = new AbortController();
  // SAFETY: Client IDs are branded strings created at the transport boundary.
  const clientId = "visitor-stream" as Parameters<RouterClient<ReturnType<typeof syncRouter>>["connect"]>[0]["clientId"];
  const events = await sync.connect({ clientId }, { signal: controller.signal });
  expect((await events.next()).value).toEqual({ type: "ready" });
  const update = events.next();
  const api = createORPCClient<{ write(): Promise<void> }>(new RPCLink({ origin: extension.origin, url: "/api", headers: { "x-halo-extension-token": "host-secret" } }));
  await api.write();
  expect((await update).value).toEqual({ type: "poke" });
  controller.abort();
  await events.return?.();
});

async function connectAs(origin: string, role: string) {
  const schema = defineSchema({ notes: collection({ id: t.id(), text: t.string() }) });
  const realFetch = globalThis.fetch;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL(`${origin}/view/`) });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    request.headers.set("x-halo-extension-token", "host-secret");
    request.headers.set("x-halo-viewer-role", role);
    request.headers.set("x-halo-viewer-id", role);
    return await realFetch(request);
  };
  try {
    return await connectExtension({ schema, relations: defineRelations(schema, () => ({})) });
  } finally {
    globalThis.fetch = realFetch;
    if (previous === undefined) Reflect.deleteProperty(globalThis, "location");
    else Object.defineProperty(globalThis, "location", previous);
  }
}
extensionTest("connectExtension renders actions-mode visitors with the API and empty local storage", async ({ extension }) => {
  const visitor = await connectAs(extension.origin, "public");
  if (visitor instanceof Error) throw visitor;
  const api = visitor.api as unknown as { viewer(): Promise<{ role: string }> };
  expect(await api.viewer()).toMatchObject({ role: "public" });
  expect(visitor.storage.query({ collection: "notes" } as never)).toEqual([]);
});

test("a standalone preview without Halo's proxy serves its owner", async () => {
  const root = path.resolve(import.meta.dirname, "../../../../tmp/extension-sharing");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "standalone-"));
  await fs.mkdir(path.join(directory, "public"));
  const schema = defineSchema({ notes: collection({ id: t.id(), text: t.string() }) });
  const running = await serveExtension({ router: { viewer: os.handler(({ context }) => context.viewer) }, schema, relations: defineRelations(schema, () => ({})), publicDirectory: path.join(directory, "public"), dataDirectory: path.join(directory, "data"), port: 0, syncAccess: "read-only" });
  if (running instanceof Error) throw running;
  try {
    const origin = new URL(running.url).origin;
    const api = createORPCClient<{ viewer(): Promise<{ role: string }> }>(new RPCLink({ origin, url: "/api" }));
    expect(await api.viewer()).toMatchObject({ role: "owner" });
    const sync = createORPCClient<{ push(input: { clientId: string; mutations: never[] }): Promise<void> }>(new RPCLink({ origin, url: "/sync" }));
    await expect(sync.push({ clientId: "preview", mutations: [] })).resolves.toBeUndefined();
  } finally {
    await running.close();
    await fs.rm(directory, { recursive: true });
  }
});

extensionTest("connectExtension still reports sync failures other than a denial", async () => {
  expect(await connectAs("http://127.0.0.1:1", "public")).toBeInstanceOf(Error);
});

extensionTest("unknown viewer roles are public", async ({ extension }) => {
  for (const role of ["visitor", "Owner", ""]) {
    const api = createORPCClient<{ viewer(): Promise<{ role: string }> }>(new RPCLink({ origin: extension.origin, url: "/api", headers: { "x-halo-extension-token": "host-secret", "x-halo-viewer-role": role } }));
    expect(await api.viewer()).toMatchObject({ role: "public" });
  }
  const api = createORPCClient<{ viewer(): Promise<{ role: string }> }>(new RPCLink({ origin: extension.origin, url: "/api", headers: { "x-halo-extension-token": "host-secret" } }));
  expect(await api.viewer()).toMatchObject({ role: "public" });
});
