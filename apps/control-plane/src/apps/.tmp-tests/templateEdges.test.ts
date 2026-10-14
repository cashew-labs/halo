import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { writeLocalExtension, buildBooksArtifact } from "../../../../../packages/workspace-server/src/extensions/.tmp-tests/appFixtures.js";
import { appWorldTest, signIn } from "./appWorld.js";
import { Browser } from "./browser.js";

vi.setConfig({ testTimeout: 180_000 });
const access = { visibility: "public" as const, members: [] };

appWorldTest.extend({ liveData: undefined })("template publication and installation fail safely", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const app = await owner.rpc.apps.publish({ extensionId: "books", access });
  const stranger = await signIn({ appDataDir, origin: plane.origin, email: "stranger@example.com" });
  // Only the owner's own live apps become templates, and only when reachable and valid.
  await expect(stranger.rpc.apps.publishTemplate({ appId: app.appId, slug: "books", description: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  provider.unreachable.add(app.appId);
  await expect(owner.rpc.apps.publishTemplate({ appId: app.appId, slug: "books", description: "x" })).rejects.toMatchObject({ message: "App VM is not reachable" });
  provider.unreachable.delete(app.appId);
  const appClient = provider.client(app.appId);
  await appClient.extensions.writeSource({ id: "books", name: "sample-data.json", contents: "{" });
  await expect(owner.rpc.apps.publishTemplate({ appId: app.appId, slug: "books", description: "x" })).rejects.toMatchObject({ message: "sample-data.json is not JSON" });
  await fs.writeFile(path.join(provider.vms.get(app.appId)!.root, "workspace/.halo/extensions/books/package.json"), "{");
  await expect(owner.rpc.apps.publishTemplate({ appId: app.appId, slug: "books", description: "x" })).rejects.toMatchObject({ message: "package.json is invalid" });
  await appClient.extensions.writeSource({ id: "books", name: "package.json", contents: JSON.stringify({ name: "books", halo: { displayName: "Books" } }) });
  await appClient.extensions.writeSource({ id: "books", name: "sample-data.json", contents: "{}" });
  const template = await owner.rpc.apps.publishTemplate({ appId: app.appId, slug: "books", description: "Books" });
  const [demo] = [...provider.vms.values()].filter((vm) => vm.assignment.sharedApp?.demo === true);
  await expect(owner.rpc.apps.publishTemplate({ appId: demo!.assignment.workspaceId, slug: "other", description: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

  // The listing is read-only; installation reports its failures and can be retried.
  expect((await fetch(template.url, { method: "POST" })).status).toBe(405);
  expect((await fetch(`${plane.origin}/api/templates/missing/install`, { method: "POST", headers: { origin: plane.origin } })).status).toBe(404);
  const recipient = await signIn({ appDataDir, origin: plane.origin, email: "reader@example.com" });
  await recipient.rpc.workspace.ensure();
  const browser = new Browser();
  browser.setCookies(new URL(plane.origin).host, recipient.headers.get("cookie"));
  const install = async (slug: string) => await browser.fetch(`${plane.origin}/api/templates/${slug}/install`, { method: "POST", origin: plane.origin });
  try {
    // The recipient already has a local "books" extension: refused before any VM is made.
    const appVms = () => provider.assignments.filter((assignment) => assignment.sharedApp !== undefined).length;
    const before = appVms();
    expect(await (await install("books")).text()).toContain("You already have an extension named books");
    expect(appVms()).toBe(before);
    // A host without app VMs refuses before anything is created.
    provider.hostsSharedApps = undefined;
    expect(await (await install("books")).text()).toContain("This Halo deployment cannot host shared apps");
    provider.hostsSharedApps = true;
    expect(appVms()).toBe(before);
    // Another template: interrupted provisioning, then a failed sandboxed build, then success.
    const author2 = await signIn({ appDataDir, origin: plane.origin, email: "second@example.com" });
    const app2 = await author2.rpc.apps.publish({ extensionId: "books", access });
    await expect(author2.rpc.apps.publishTemplate({ appId: app2.appId, slug: "books", description: "x" })).rejects.toMatchObject({ message: "Another template already uses this name" });
    await provider.client(app2.appId).extensions.writeSource({ id: "books", name: "sample-data.json", contents: "{}" });
    await author2.rpc.apps.publishTemplate({ appId: app2.appId, slug: "shelf", description: "x" });
    provider.failAppEnsures = 1;
    const interrupted = await install("shelf");
    expect(interrupted.status).toBe(400);
    expect(await interrupted.text()).toContain("Installation was interrupted.");
    const [pending] = await recipient.rpc.apps.list();
    provider.buildExitCodes.push(1);
    expect(await (await install("shelf")).text()).toContain("The template did not build");
    expect((await provider.client(provider.ownerVm(recipient.userId).assignment.workspaceId).extensions.list()).map((extension) => extension.id)).toEqual(["books"]);
    expect((await install("shelf")).status).toBe(200);
    // A later app of the same name is a different app.
    await recipient.rpc.apps.cancel({ appId: pending!.appId }).catch(() => undefined);
    const author3 = await signIn({ appDataDir, origin: plane.origin, email: "third@example.com" });
    const app3 = await author3.rpc.apps.publish({ extensionId: "books", slug: "kept", access });
    await provider.client(app3.appId).extensions.writeSource({ id: "books", name: "sample-data.json", contents: "{}" });
    await author3.rpc.apps.publishTemplate({ appId: app3.appId, slug: "kept", description: "x" });
    // The recipient's own app named "kept" is never replaced by a template copy.
    await writeLocalExtension({ workspaceRoot: path.join(provider.ownerVm(recipient.userId).root, "workspace"), id: "kept", artifact: await buildBooksArtifact() });
    await provider.client(provider.ownerVm(recipient.userId).assignment.workspaceId).extensions.reload();
    await recipient.rpc.apps.publish({ extensionId: "kept", access });
    expect(await (await install("kept")).text()).toContain("You already have an app named kept");
  } finally {
    await browser.close();
  }
});

appWorldTest("demo instances restart after a crash and report capacity failures", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const app = await owner.rpc.apps.publish({ extensionId: "books", access });
  await provider.client(app.appId).extensions.writeSource({ id: "books", name: "sample-data.json", contents: "{}" });
  const template = await owner.rpc.apps.publishTemplate({ appId: app.appId, slug: "books", description: "Books" });
  const demoVm = [...provider.vms.values()].find((vm) => vm.assignment.sharedApp?.demo === true)!;
  const visitor = new Browser();
  try {
    expect((await visitor.fetch(template.demoUrl)).status).toBe(200);
    demoVm.supervisor!.crashInstances();
    // The host's status poll notices the dead backend, then the next request restarts it.
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    expect((await visitor.fetch(template.demoUrl)).status).toBe(200);
    demoVm.supervisor!.failInstanceStarts.value = true;
    expect((await new Browser().fetch(template.demoUrl)).status).toBe(404);
    // App VMs never take workspace references.
    await expect(provider.client(app.appId).extensions.addRemote({ id: "x", appId: app.appId, url: "https://x.example/", displayName: "X" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  } finally {
    await visitor.close();
  }
});

appWorldTest("template names, demo paths and retries stay bound to one source app", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  await owner.rpc.workspace.ensure();
  const app = await owner.rpc.apps.publish({ extensionId: "books", access });
  const appClient = provider.client(app.appId);
  await appClient.extensions.writeSource({ id: "books", name: "sample-data.json", contents: "{}" });
  const appVms = () => provider.assignments.filter((assignment) => assignment.sharedApp !== undefined).length;
  const before = appVms();
  // demo-<name> must fit the 63-character app path.
  await expect(owner.rpc.apps.publishTemplate({ appId: app.appId, slug: `a${"b".repeat(58)}`, description: "x" })).rejects.toMatchObject({ message: "Template names can have at most 58 characters" });
  expect(appVms()).toBe(before);
  // An ordinary app whose ID is demo-<name> is never adopted as a demo.
  const ownerRoot = path.join(provider.ownerVm(owner.userId).root, "workspace");
  const ownerClient = provider.client(provider.ownerVm(owner.userId).assignment.workspaceId);
  await writeLocalExtension({ workspaceRoot: ownerRoot, id: "demo-shelf", artifact: await buildBooksArtifact() });
  await ownerClient.extensions.reload();
  await owner.rpc.apps.publish({ extensionId: "demo-shelf", slug: "shelf-app", access });
  await expect(owner.rpc.apps.publishTemplate({ appId: app.appId, slug: "shelf", description: "x" })).rejects.toMatchObject({ message: "Another app already uses demo-shelf" });
  // An interrupted demo copy is not listed, and its retry installs the stored artifact.
  provider.failAppEnsures = 1;
  await expect(owner.rpc.apps.publishTemplate({ appId: app.appId, slug: "reading", description: "x" })).rejects.toBeDefined();
  expect((await fetch(`${plane.origin}/templates/reading`)).status).toBe(404);
  await appClient.extensions.writeSource({ id: "books", name: "api.ts", contents: "// edited after the first attempt" });
  // Another of the owner's apps cannot continue this template.
  await writeLocalExtension({ workspaceRoot: ownerRoot, id: "notes", artifact: await buildBooksArtifact() });
  await ownerClient.extensions.reload();
  const other = await owner.rpc.apps.publish({ extensionId: "notes", access });
  await expect(owner.rpc.apps.publishTemplate({ appId: other.appId, slug: "reading", description: "x" })).rejects.toMatchObject({ message: "Another template already uses this name" });
  const template = await owner.rpc.apps.publishTemplate({ appId: app.appId, slug: "reading", description: "x" });
  expect((await fetch(template.url)).status).toBe(200);
  const demo = [...provider.vms.values()].find((vm) => vm.assignment.sharedApp?.extensionId === "demo-reading")!;
  expect(await provider.client(demo.assignment.workspaceId).extensions.readSource({ id: "demo-reading", name: "api.ts" })).toBe("export default {};");
  // Publishing again is idempotent.
  expect(await owner.rpc.apps.publishTemplate({ appId: app.appId, slug: "reading", description: "x" })).toEqual(template);
});
