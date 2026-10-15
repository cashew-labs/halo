import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import path from "node:path";
import { expect, vi } from "vitest";
import { buildBooksArtifact, writeLocalExtension } from "../../../../../packages/workspace-server/src/extensions/.tmp-tests/appFixtures.js";
import { appWorldTest, createControlPlaneRpcClient, signIn } from "./appWorld.js";
import { connectPages, startPagesApi } from "./pagesApi.js";

vi.setConfig({ testTimeout: 90_000 });
const access = { visibility: "public" as const, members: [] };

appWorldTest("owners bind fixed actions to their own connected tools", async ({ appDataDir, plane, provider }) => {
  const pages = await startPagesApi();
  try {
    const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
    await owner.rpc.workspace.ensure();
    const { address } = await connectPages({ owner, endpoint: pages.endpoint, origin: plane.origin, provider });
    const app = await owner.rpc.apps.publish({ extensionId: "books", access });
    const action = { name: "addPage", description: "Add a page", address, arguments: { database: "reading-db", title: "x" } };
    const bound = await owner.rpc.apps.bindActions({ appId: app.appId, actions: [action, { ...action, name: "addSample", sampleResult: { created: true } }] });
    expect(bound.actions).toEqual([{ name: "addPage", description: "Add a page" }, { name: "addSample", description: "Add a page" }]);
    await expect(owner.rpc.apps.bindActions({ appId: app.appId, actions: [action, action] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("unique") });
    expect((await owner.rpc.apps.bindActions({ appId: app.appId, actions: [] })).actions).toEqual([]);
  } finally {
    await pages.close();
  }
});

appWorldTest.extend({ integrationKey: undefined })("without integrations, apps publish but cannot bind actions", async ({ appDataDir, plane }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const app = await owner.rpc.apps.publish({ extensionId: "books", access });
  await expect(owner.rpc.apps.bindActions({ appId: app.appId, actions: [{ name: "addPage", description: "Add", address: "pages.main.create_page", arguments: {} }] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Integration actions are unavailable" });
});

appWorldTest("invalid packages, taken links and unreachable VMs fail without moving the app", async ({ appDataDir, plane, provider, artifact }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  await owner.rpc.workspace.ensure();
  const ownerVm = provider.ownerVm();
  const root = path.join(ownerVm.root, "workspace");
  const ownerClient = provider.client(ownerVm.assignment.workspaceId);
  for (const [id, packageJson] of [["broken", "{"], ["wrong", JSON.stringify({ name: 7, halo: "x" })], ["undeclared", JSON.stringify({ name: "x", halo: { app: { sync: "everything" } } })]] as const) {
    await writeLocalExtension({ workspaceRoot: root, id, artifact: { ...artifact, files: { ...artifact.files, "package.json": packageJson } } });
    await expect(owner.rpc.apps.publish({ extensionId: id, access })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await fs.rm(path.join(root, ".halo/extensions", id), { recursive: true });
  }
  expect(await owner.rpc.apps.list()).toEqual([]);

  // A second extension cannot take a link the first one uses.
  await owner.rpc.apps.publish({ extensionId: "books", access });
  await writeLocalExtension({ workspaceRoot: root, id: "shelf", artifact: await buildBooksArtifact() });
  await ownerClient.extensions.reload();
  await expect(owner.rpc.apps.publish({ extensionId: "shelf", slug: "books", access })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Another app already uses this link" });
  // App VMs freeze nothing, and an app VM that never answers times out.
  const [published] = await owner.rpc.apps.list();
  await expect(provider.client(published!.appId).extensions.freeze({ id: "books", appId: published!.appId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  provider.unreachable.add(published!.appId);
  await expect(owner.rpc.apps.readSource({ appId: published!.appId, name: "api.ts" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "App VM is not reachable" });
  provider.unreachable.delete(published!.appId);
  provider.appsUnreachable = true;
  await expect(owner.rpc.apps.publish({ extensionId: "shelf", access })).rejects.toBeDefined();
  provider.appsUnreachable = false;
  // An owner workspace that is still booting is reported, not guessed.
  provider.unreachable.add(ownerVm.assignment.workspaceId);
  await expect(owner.rpc.apps.publish({ extensionId: "shelf", access })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Your workspace is starting" });
  provider.unreachable.delete(ownerVm.assignment.workspaceId);
  expect(await owner.rpc.apps.publish({ extensionId: "shelf", access })).toMatchObject({ slug: "shelf", stage: "live" });
});

appWorldTest("the owner's agent reaches apps only with a current workspace credential", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  await owner.rpc.apps.publish({ extensionId: "books", access });
  const ownerClient = provider.client(provider.ownerVm().assignment.workspaceId);
  expect(await ownerClient.apps.list()).toHaveLength(1);
  // A live app is unpublished, not cancelled; the agent sees the reason.
  await expect(ownerClient.apps.cancel({ appId: (await ownerClient.apps.list())[0]!.appId })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Published apps are unpublished, not cancelled" });
  // The owner's own Halo traffic still reaches the workspace through the gateway.
  expect((await fetch(`${plane.origin}/workspace/health`, { headers: owner.headers })).status).toBe(200);
  const upgraded = await new Promise<number>((resolve) => {
    const request = http.request(`${plane.origin}/workspace/extensions/books/sync/connect`, { headers: { cookie: owner.headers.get("cookie")!, origin: plane.origin, connection: "upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    request.on("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode ?? 0); });
    request.on("response", (response) => { response.resume(); resolve(response.statusCode ?? 0); });
    request.on("error", () => resolve(0));
    request.end();
  });
  expect(upgraded).toBeGreaterThan(0);
  await owner.rpc.workspace.rotateRuntimeToken();
  // The VM still holds the revoked token; the control plane refuses it.
  await expect(ownerClient.apps.list()).rejects.toBeDefined();
  expect(createControlPlaneRpcClient).toBeDefined();
});

appWorldTest("publication failures before the copy restore the extension and free the link", async ({ appDataDir, plane, provider, artifact }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  await owner.rpc.workspace.ensure();
  const ownerVm = provider.ownerVm();
  const root = path.join(ownerVm.root, "workspace");
  const ownerClient = provider.client(ownerVm.assignment.workspaceId);
  // A host without app VMs refuses before anything stops.
  provider.hostsSharedApps = undefined;
  await expect(owner.rpc.apps.publish({ extensionId: "books", access })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This Halo deployment cannot host shared apps" });
  provider.hostsSharedApps = true;
  expect(await ownerClient.extensions.list()).toMatchObject([{ id: "books" }]);
  // A missing extension leaves no record holding its link.
  await expect(owner.rpc.apps.publish({ extensionId: "shelf", access })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await owner.rpc.apps.list()).toEqual([]);
  // An unbuilt extension is released and runs locally again.
  const { build: _build, ...unbuilt } = artifact;
  await writeLocalExtension({ workspaceRoot: root, id: "shelf", artifact: { ...unbuilt, build: {} } });
  await ownerClient.extensions.reload();
  const before = await ownerClient.extensions.list();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // The second attempt fails the same way: nothing stayed frozen.
    await expect(owner.rpc.apps.publish({ extensionId: "shelf", access })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("current build") });
    expect(await owner.rpc.apps.list()).toEqual([]);
    expect(await ownerClient.extensions.list()).toEqual(before);
  }
  expect(provider.assignments.filter((assignment) => assignment.sharedApp !== undefined)).toEqual([]);
  // The freed link is available to the next publication.
  expect(await owner.rpc.apps.publish({ extensionId: "books", slug: "shelf", access })).toMatchObject({ slug: "shelf", stage: "live" });
});

appWorldTest("a copy already on its app VM cannot be cancelled; publishing again finishes it", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const app = await owner.rpc.apps.publish({ extensionId: "books", access });
  // The state after the app VM installed the copy but the owner's reference failed.
  {
    using database = new DatabaseSync(path.join(appDataDir, "control-plane.db.apps"));
    database.prepare("UPDATE apps SET stage = 'ready' WHERE app_id = ?").run(app.appId);
  }
  expect(await owner.rpc.apps.list()).toMatchObject([{ appId: app.appId, stage: "publishing" }]);
  await expect(owner.rpc.apps.cancel({ appId: app.appId })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "The app already runs on its VM; publish it again to finish" });
  expect(await owner.rpc.apps.publish({ extensionId: "books", access })).toMatchObject({ appId: app.appId, stage: "live" });
  expect(provider.assignments.filter((assignment) => assignment.sharedApp !== undefined)).toHaveLength(1);
});

appWorldTest("one owner's slow app VM does not delay another owner's publication", async ({ appDataDir, plane, provider }) => {
  const slow = await signIn({ appDataDir, origin: plane.origin, email: "slow@example.com" });
  const fast = await signIn({ appDataDir, origin: plane.origin, email: "fast@example.com" });
  await slow.rpc.workspace.ensure();
  await fast.rpc.workspace.ensure();
  let resume = () => {};
  provider.heldOwners.set(slow.userId, new Promise<void>((resolve) => { resume = resolve; }));
  const pending = slow.rpc.apps.publish({ extensionId: "books", access });
  await expect.poll(() => provider.assignments.some((assignment) => assignment.ownerUserId === slow.userId && assignment.sharedApp !== undefined)).toBe(true);
  expect(await fast.rpc.apps.publish({ extensionId: "books", access })).toMatchObject({ handle: "fast", stage: "live" });
  resume();
  expect(await pending).toMatchObject({ handle: "slow", stage: "live" });
});

appWorldTest("a frozen record whose VM already runs the copy cannot be cancelled", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const app = await owner.rpc.apps.publish({ extensionId: "books", access });
  // The state after the app VM installed the copy but the reply or `advance` was lost.
  {
    using database = new DatabaseSync(path.join(appDataDir, "control-plane.db.apps"));
    database.prepare("UPDATE apps SET stage = 'frozen' WHERE app_id = ?").run(app.appId);
  }
  await expect(owner.rpc.apps.cancel({ appId: app.appId })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "The app already runs on its VM; publish it again to finish" });
  expect((await provider.client(app.appId).extensions.list()).map((extension) => extension.id)).toEqual(["books"]);
});

appWorldTest("a publication whose app VM never answers is cancelled and its VM deleted", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  await owner.rpc.workspace.ensure();
  provider.appsBroken = true;
  await expect(owner.rpc.apps.publish({ extensionId: "books", access })).rejects.toBeDefined();
  const [pending] = await owner.rpc.apps.list();
  expect(pending).toMatchObject({ stage: "publishing" });
  expect(provider.vms.has(pending!.appId)).toBe(true);
  await owner.rpc.apps.cancel({ appId: pending!.appId });
  expect(await owner.rpc.apps.list()).toEqual([]);
  expect(provider.removed).toEqual([pending!.appId]);
  expect(await provider.client(provider.ownerVm().assignment.workspaceId).extensions.list()).toMatchObject([{ id: "books" }]);
});
