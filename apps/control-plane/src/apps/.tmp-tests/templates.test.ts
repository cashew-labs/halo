import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, vi } from "vitest";
import { appWorldTest, signIn } from "./appWorld.js";
import { Browser } from "./browser.js";
import { connectPages, startPagesApi } from "./pagesApi.js";

vi.setConfig({ testTimeout: 180_000 });

const router = `
  addPage: os.handler(({ context }) => context.tools.actions.addPage({})),
  chat: os.handler(({ context }) => context.tools.conversation.send({ viewerToken: context.viewer.token, message: "hi" })),
`;
const name = '<img src=x onerror="alert(1)">Books';

appWorldTest.extend({ router, liveData: undefined })("templates publish sample data with isolated per-visitor demos and install as private copies", async ({ appDataDir, plane, provider, artifact }) => {
  const pages = await startPagesApi();
  const visitors = [new Browser(), new Browser(), new Browser(), new Browser()];
  const recipientBrowser = new Browser();
  try {
    // The author's app has live data, a fixed request naming their resource, and sample data.
    const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
    await owner.rpc.workspace.ensure();
    const { address } = await connectPages({ owner, endpoint: pages.endpoint, origin: plane.origin, provider });
    const ownerVm = provider.ownerVm();
    await fs.writeFile(path.join(ownerVm.root, "workspace/.halo/extensions/books/package.json"), JSON.stringify({ name: "books", halo: { displayName: name, app: { description: "Books", sync: "read-only", actions: [{ name: "addPage", description: "Add a page", address, arguments: { database: "author-private-db", title: "x" }, sampleResult: { created: "sample page" } }] } } }));
    const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
    // The author writes sample data in the app's real storage format.
    const author = new Browser();
    expect((await author.api(app.url, "write")).status).toBe(200);
    await author.close();
    const live = (await provider.client(app.appId).extensions.snapshot({ id: "books" })).data!;
    expect(live).toContain("visitor data");
    const sampleData = live.replace("visitor data", "sample row");
    await provider.client(app.appId).extensions.writeSource({ id: "books", name: "sample-data.json", contents: sampleData });

    // The author's live app keeps serving while its template is published: no restart, same tool token.
    const watcher = new Browser();
    const tokenBefore = (await watcher.api(app.url, "token")).body;
    await expect(owner.rpc.apps.publishTemplate({ appId: "00000000-0000-0000-0000-000000000000", slug: "reading", description: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const template = await owner.rpc.apps.publishTemplate({ appId: app.appId, slug: "reading", description: 'Track books <b>"together"</b>' });
    const port = new URL(plane.origin).port;
    expect(template).toEqual({ slug: "reading", displayName: name, description: 'Track books <b>"together"</b>', url: `${plane.origin}/templates/reading`, demoUrl: `http://creator.localhost:${port}/demo-reading/view/` });
    expect(await owner.rpc.apps.publishTemplate({ appId: app.appId, slug: "reading", description: "again" })).toMatchObject({ slug: "reading" });
    expect((await watcher.api(app.url, "token")).body).toEqual(tokenBefore);
    await watcher.close();
    const stranger = await signIn({ appDataDir, origin: plane.origin, email: "stranger@example.com" });
    await expect(stranger.rpc.apps.publishTemplate({ appId: app.appId, slug: "taken", description: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // The demo is not one of the author's apps, and runs on its own demo VM.
    expect((await owner.rpc.apps.list()).map((entry) => entry.appId)).toEqual([app.appId]);
    const demoVm = [...provider.vms.values()].find((vm) => vm.assignment.sharedApp?.demo === true)!;
    expect(demoVm.assignment.sharedApp).toMatchObject({ extensionId: "demo-reading", demo: true });
    // Publishing a local extension with the demo's ID cannot adopt the demo record.
    await expect(owner.rpc.apps.publish({ extensionId: "demo-reading", slug: "reading-app", access: { visibility: "invited", members: ["x@example.com"] } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await owner.rpc.apps.list()).map((entry) => entry.appId)).toEqual([app.appId]);

    // The stored template holds sample data, never live data or the fixed resource.
    using database = new DatabaseSync(path.join(appDataDir, "control-plane.db.apps"));
    const stored = database.prepare("SELECT artifact FROM templates").get() as { artifact: string };
    expect(stored.artifact).not.toContain("visitor data");
    expect(stored.artifact).not.toContain("author-private-db");
    expect(JSON.parse(stored.artifact).data).toBe(JSON.stringify(JSON.parse(sampleData)));

    // The trusted listing escapes the template's text and frames only the demo origin.
    const listing = await fetch(`${plane.origin}/templates/reading`);
    const html = await listing.text();
    expect(listing.status).toBe(200);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;Books");
    expect(html).toContain("Track books &lt;b&gt;&quot;together&quot;&lt;/b&gt;");
    expect(html).toContain(`src="http://creator.localhost:${port}/demo-reading/view/"`);
    expect(listing.headers.get("content-security-policy")).toContain(`frame-src http://creator.localhost:${port};`);
    expect(listing.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain('action="/api/templates/reading/signin"');
    expect((await fetch(`${plane.origin}/templates/missing`)).status).toBe(404);

    // Each visitor gets a separate demo starting from sample data.
    const demo = `http://creator.localhost:${port}/demo-reading/`;
    const [alice, bob] = visitors;
    expect((await alice!.fetch(`${demo}view/`)).status).toBe(200);
    expect((await alice!.api(demo, "write")).status).toBe(200);
    expect((await bob!.fetch(`${demo}view/`)).status).toBe(200);
    const instances = path.join(demoVm.root, "workspace/.halo/extension-data/demo-reading/instances");
    const contents = await Promise.all((await fs.readdir(instances)).map(async (entry) => await fs.readFile(path.join(instances, entry, "tandem.json"), "utf8")));
    expect(contents).toHaveLength(2);
    // Alice's change stays in her instance; Bob still sees the sample.
    expect(contents.filter((text) => text.includes("visitor data"))).toHaveLength(1);
    expect(contents.filter((text) => text.includes("sample row"))).toHaveLength(1);
    // Demo actions replay the sample result and never reach the author's connection.
    const before = pages.calls.length;
    expect((await alice!.api(demo, "addPage")).body).toMatchObject({ ok: true, data: { created: "sample page" } });
    expect(pages.calls.length).toBe(before);
    expect((await alice!.api(demo, "chat")).body).toMatchObject({ ok: false });
    // While three demos are in use a fourth visitor is told to retry; nobody's demo is evicted.
    expect((await bob!.fetch(`${demo}view/`)).status).toBe(200);
    expect((await visitors[2]!.fetch(`${demo}view/`)).status).toBe(200);
    const busy = await visitors[3]!.fetch(`${demo}view/`);
    expect([busy.status, await busy.text()]).toEqual([503, "This demo is busy. Try again in a few minutes."]);
    expect(await fs.readdir(instances)).toHaveLength(3);
    const remaining = await Promise.all((await fs.readdir(instances)).map(async (entry) => await fs.readFile(path.join(instances, entry, "tandem.json"), "utf8")));
    expect(remaining.some((text) => text.includes("visitor data"))).toBe(true);

    // Installing needs a signed-in Halo user and a form from Halo's own origin.
    const recipient = await signIn({ appDataDir, origin: plane.origin, email: "reader@example.com" });
    const core = new URL(plane.origin).host;
    recipientBrowser.setCookies(core, recipient.headers.get("cookie"));
    const signedIn = await recipientBrowser.fetch(`${plane.origin}/templates/reading`);
    expect(await signedIn.text()).toContain('action="/api/templates/reading/install"');
    expect((await recipientBrowser.fetch(`${plane.origin}/api/templates/reading/install`, { method: "POST", origin: `http://creator.localhost:${port}` })).status).toBe(403);
    expect((await new Browser().fetch(`${plane.origin}/api/templates/reading/install`, { method: "POST", origin: plane.origin })).status).toBe(401);
    expect((await recipientBrowser.fetch(`${plane.origin}/api/templates/reading/install`)).status).toBe(405);
    const signinRedirect = await recipientBrowser.fetch(`${plane.origin}/api/templates/reading/signin`, { method: "POST", origin: plane.origin });
    expect(new URL(signinRedirect.headers.get("location")!).host).toBe("accounts.google.com");
    // A stopped local project with the same name keeps it; the copy is abandoned and its VM removed.
    await recipient.rpc.workspace.ensure();
    const localProject = path.join(provider.ownerVm(recipient.userId).root, "workspace/.halo/extensions/reading");
    await fs.mkdir(localProject, { recursive: true });
    await fs.writeFile(path.join(localProject, "package.json"), JSON.stringify({ name: "reading" }));
    const clash = await recipientBrowser.fetch(`${plane.origin}/api/templates/reading/install`, { method: "POST", origin: plane.origin });
    expect(clash.status).not.toBe(200);
    expect(await clash.text()).toContain("You already have an extension named reading");
    expect(await recipient.rpc.apps.list()).toEqual([]);
    expect(provider.removed).toHaveLength(1);
    await fs.rm(localProject, { recursive: true });
    const installed = await recipientBrowser.fetch(`${plane.origin}/api/templates/reading/install`, { method: "POST", origin: plane.origin });
    expect(installed.status).toBe(200);
    expect(await installed.text()).toContain("Installed");
    const [copy] = await recipient.rpc.apps.list();
    expect(copy).toMatchObject({ extensionId: "reading", handle: "reader", published: false, stage: "live", actions: [], url: `http://reader.localhost:${port}/reading/` });
    // A second install resumes the same copy.
    expect((await recipientBrowser.fetch(`${plane.origin}/api/templates/reading/install`, { method: "POST", origin: plane.origin })).status).toBe(200);
    expect((await recipient.rpc.apps.list()).map((entry) => entry.appId)).toEqual([copy!.appId]);
    // Publishing a local extension with the copy's ID cannot adopt the installed copy; sharing it uses update.
    await expect(recipient.rpc.apps.publish({ extensionId: "reading", access: { visibility: "public", members: [] } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await recipient.rpc.apps.list()).toMatchObject([{ appId: copy!.appId, published: false }]);
    // The copy runs on its own VM with sample data, rebuilt in its build sandbox.
    const copyVm = provider.vms.get(copy!.appId)!;
    expect(copyVm.root).not.toBe(provider.vms.get(app.appId)!.root);
    expect(copyVm.supervisor!.commands).toEqual(["npm install --no-audit --no-fund && npm run build"]);
    const copied = await provider.client(copy!.appId).extensions.snapshot({ id: "reading" });
    expect(copied.data).toBe(JSON.stringify(JSON.parse(sampleData)));
    expect(copied.files["package.json"]).not.toContain("author-private-db");
    // The recipient's workspace references the copy; the author's connection is not bound.
    expect(await provider.client(provider.ownerVm(recipient.userId).assignment.workspaceId).extensions.list()).toContainEqual({ id: "reading", url: `${copy!.url}view/`, displayName: name, remote: { appId: copy!.appId } });
    // Snapshots for templates never read live data.
    expect((await provider.client(app.appId).extensions.snapshot({ id: "books", data: false })).data).toBeUndefined();
  } finally {
    for (const browser of [...visitors, recipientBrowser]) await browser.close();
    await pages.close();
  }
});
