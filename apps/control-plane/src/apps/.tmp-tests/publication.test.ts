import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { appWorldTest, createControlPlaneRpcClient, signIn } from "./appWorld.js";

vi.setConfig({ testTimeout: 60_000 });

appWorldTest("publishing moves the app to its own VM and leaves the owner one remote reference", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "Michael.K@example.com" });
  const published = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
  const port = new URL(plane.origin).port;
  expect(published).toMatchObject({ extensionId: "books", displayName: "Books", handle: "michael-k", slug: "books", url: `http://michael-k.localhost:${port}/books/`, stage: "live", published: true, visibility: "public", actions: [] });

  // The app VM is a separate VM with its own identity and an app-only credential.
  const appVm = provider.vms.get(published.appId)!;
  expect(appVm.assignment).toMatchObject({ workspaceId: published.appId, runtime: { workspaceId: published.appId }, sharedApp: { appId: published.appId, extensionId: "books", syncAccess: "read-only" } });
  expect(appVm.assignment.runtime.token).toMatch(/^halo_app_/);
  const ownerVm = provider.ownerVm();
  expect(appVm.root).not.toBe(ownerVm.root);
  expect(await provider.client(published.appId).extensions.list()).toMatchObject([{ id: "books", displayName: "Books" }]);
  expect((await provider.client(published.appId).extensions.snapshot({ id: "books" })).data).toBe('{"owner":"live data"}');

  // The owner workspace keeps only a reference; there is no second live copy.
  const ownerClient = provider.client(ownerVm.assignment.workspaceId);
  expect(await ownerClient.extensions.list()).toEqual([{ id: "books", url: `${published.url}view/`, displayName: "Books", remote: { appId: published.appId } }]);
  await expect(fs.stat(path.join(ownerVm.root, "workspace/.halo/extensions/books"))).rejects.toThrow();

  // The app credential never acts as the owner or the owner's workspace.
  const appToken = appVm.assignment.runtime.token;
  expect((await fetch(`${plane.origin}/api/workspace-runtime/identity`, { headers: { authorization: `Bearer ${appToken}` } })).status).toBe(401);
  const asApp = createControlPlaneRpcClient(plane.origin, appToken);
  await expect(asApp.apps.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(asApp.integrations.invoke({ address: "x.y.z", arguments: {} })).rejects.toMatchObject({ code: "UNAUTHORIZED" });

  // Owner edits reach the app VM, both from Halo and from the owner's agent.
  await owner.rpc.apps.writeSource({ appId: published.appId, name: "api.ts", contents: "// edited remotely" });
  expect(await ownerClient.apps.readSource({ appId: published.appId, name: "api.ts" })).toBe("// edited remotely");
  expect(await ownerClient.apps.execSource({ appId: published.appId, command: "npm run build" })).toEqual({ output: "npm run build", exitCode: 0 });
  await ownerClient.apps.restart({ appId: published.appId });
  await expect(ownerClient.apps.readSource({ appId: published.appId, name: "../secret" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

  // Retrying publication changes access only; the live copy is never replaced.
  const invited = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "invited", members: ["Friend@Example.com"] } });
  expect(invited).toMatchObject({ appId: published.appId, visibility: "invited", members: ["friend@example.com"], stage: "live" });
  expect(await owner.rpc.apps.readSource({ appId: published.appId, name: "api.ts" })).toBe("// edited remotely");
  expect(await owner.rpc.apps.update({ appId: published.appId, published: false })).toMatchObject({ published: false });
  expect(await ownerClient.apps.list()).toMatchObject([{ appId: published.appId, published: false }]);
  await expect(owner.rpc.apps.cancel({ appId: published.appId })).rejects.toMatchObject({ code: "BAD_REQUEST" });

  // Another Halo user cannot see or operate the app.
  const stranger = await signIn({ appDataDir, origin: plane.origin, email: "stranger@example.com" });
  expect(await stranger.rpc.apps.list()).toEqual([]);
  for (const call of [() => stranger.rpc.apps.readSource({ appId: published.appId, name: "api.ts" }), () => stranger.rpc.apps.update({ appId: published.appId, published: true }), () => stranger.rpc.apps.execSource({ appId: published.appId, command: "rm -rf ." }), () => stranger.rpc.apps.bindActions({ appId: published.appId, actions: [] })])
    await expect(call()).rejects.toMatchObject({ code: "BAD_REQUEST" });

  // Cookie sessions require Halo's own origin.
  const forged = new Headers(owner.headers); forged.set("origin", `http://michael-k.localhost:${port}`);
  await expect(createControlPlaneRpcClient(plane.origin, forged).apps.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  const originless = new Headers(owner.headers); originless.delete("origin");
  await expect(createControlPlaneRpcClient(plane.origin, originless).apps.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
});

appWorldTest("an interrupted publication keeps the local app frozen, then resumes or cancels without data loss", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "owner@example.com" });
  provider.failAppEnsures = 1;
  await expect(owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } })).rejects.toBeDefined();
  const [pending] = await owner.rpc.apps.list();
  expect(pending).toMatchObject({ stage: "publishing" });
  const ownerClient = provider.client(provider.ownerVm().assignment.workspaceId);
  // Visitors cannot change frozen data while the copy is pending.
  expect(await ownerClient.extensions.list()).toEqual([]);
  await expect(owner.rpc.apps.readSource({ appId: pending!.appId, name: "api.ts" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

  // Cancelling restores the local app with its data.
  await owner.rpc.apps.cancel({ appId: pending!.appId });
  expect(await owner.rpc.apps.list()).toEqual([]);
  expect(await ownerClient.extensions.list()).toMatchObject([{ id: "books" }]);
  expect((await ownerClient.extensions.snapshot({ id: "books" })).data).toBe('{"owner":"live data"}');

  // A failed install is retried with the same install ID and completes once.
  provider.failAppEnsures = 1;
  await expect(owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } })).rejects.toBeDefined();
  const resumed = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
  expect(resumed).toMatchObject({ stage: "live" });
  expect((await provider.client(resumed.appId).extensions.snapshot({ id: "books" })).data).toBe('{"owner":"live data"}');
  expect(await ownerClient.extensions.list()).toMatchObject([{ id: "books", remote: { appId: resumed.appId } }]);
});

appWorldTest.extend({ packageJson: { name: "books", halo: { displayName: "Books", app: { description: "Reading list", sync: "shared", actions: [{ name: "addPage", description: "Add a page", address: "notion.main.pages_create", arguments: { parent: { database_id: "abc" } } }] } } } })(
  "an app whose actions do not name the owner's connected tools never leaves the workspace",
  async ({ appDataDir, plane, provider }) => {
    const owner = await signIn({ appDataDir, origin: plane.origin, email: "owner@example.com" });
    await expect(owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("addPage") });
    expect(await owner.rpc.apps.list()).toEqual([]);
    expect(await provider.client(provider.ownerVm().assignment.workspaceId).extensions.list()).toMatchObject([{ id: "books" }]);
    expect([...provider.vms.values()].filter((vm) => vm.assignment.sharedApp !== undefined)).toEqual([]);
    await expect(owner.rpc.apps.publish({ extensionId: "books", slug: "demo-books", access: { visibility: "public", members: [] } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(owner.rpc.apps.publish({ extensionId: "books", slug: "Bad Slug", access: { visibility: "public", members: [] } })).rejects.toBeDefined();
  },
);
