import { expect, vi } from "vitest";
import { appWorldTest, createControlPlaneRpcClient, signIn } from "./appWorld.js";
import { Browser } from "./browser.js";
import { startPagesApi } from "./pagesApi.js";

vi.setConfig({ testTimeout: 120_000 });

const router = `
  addPage: os.handler(({ context }) => context.tools.actions.addPage({})),
  addOwnPage: os.handler(({ context }) => context.tools.actions.addPage({ database: "attacker-db", title: "x" })),
  addExactPage: os.handler(({ context }) => context.tools.actions.addPage({ database: "reading-db", title: "From the app" })),
  removePage: os.handler(({ context }) => context.tools.actions.removePage({})),
  shell: os.handler(({ context }) => context.tools.shell.exec({ command: "id" })),
  integration: os.handler(({ context }) => context.tools.integrations.invoke({ address: "x", arguments: {} })),
`;

appWorldTest.extend({ router })("published actions run only the owner's fixed request against the owner's connection", async ({ appDataDir, plane, provider }) => {
  const pages = await startPagesApi();
  try {
    const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
    const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
    // The owner connects the service and resolves the exact resource for the app.
    await owner.rpc.integrations.registerMcp({ name: "Pages", slug: "pages", endpoint: pages.endpoint, auth: "none" });
    const setup = await owner.rpc.integrations.startSetup({ integration: "pages", connectionName: "main" });
    await owner.rpc.integrations.submitSetup({ setupId: setup.setupId, template: "none", values: {} });
    const ownerRuntime = createControlPlaneRpcClient(plane.origin, provider.ownerVm().assignment.runtime.token);
    const [tool] = (await ownerRuntime.integrations.search({ query: "create_page", integration: "pages" })).tools;
    expect(tool).toBeDefined();
    const fixed = { database: "reading-db", title: "From the app" };
    await expect(owner.rpc.apps.bindActions({ appId: app.appId, actions: [{ name: "addPage", description: "Add a page", address: "pages.main.missing", arguments: fixed }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const stranger = await signIn({ appDataDir, origin: plane.origin, email: "stranger@example.com" });
    await expect(stranger.rpc.apps.bindActions({ appId: app.appId, actions: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const bound = await owner.rpc.apps.bindActions({ appId: app.appId, actions: [{ name: "addPage", description: "Add a page", address: tool!.address, arguments: fixed, sampleResult: { created: true } }] });
    expect(bound.actions).toEqual([{ name: "addPage", description: "Add a page" }]);

    const visitor = new Browser();
    try {
      expect((await visitor.api(app.url, "addPage")).body).toMatchObject({ ok: true });
      expect(JSON.stringify((await visitor.api(app.url, "addExactPage")).body)).toContain("created in reading-db");
      // App code cannot redirect the action to another resource or call anything else.
      expect((await visitor.api(app.url, "addOwnPage")).body).toMatchObject({ ok: false, error: { code: "invalid_action" } });
      expect((await visitor.api(app.url, "removePage")).body).toMatchObject({ ok: false, error: { code: "invalid_action" } });
      expect((await visitor.api(app.url, "shell")).body).toMatchObject({ ok: false });
      expect((await visitor.api(app.url, "integration")).body).toMatchObject({ ok: false });
      expect(pages.calls).toEqual([fixed, fixed]);
    } finally {
      await visitor.close();
    }

    // Only the app's own current credential reaches the action endpoint.
    const appToken = provider.vms.get(app.appId)!.assignment.runtime.token;
    const call = async (token: string | undefined, body: object = {}) =>
      await fetch(`${plane.origin}/api/app-runtime/actions/addPage`, { method: "POST", headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
    expect((await call(undefined)).status).toBe(401);
    expect((await call(ownerRuntime === undefined ? "" : provider.ownerVm().assignment.runtime.token)).status).toBe(401);
    expect((await call(appToken.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).status).toBe(401);
    expect((await call(appToken.replace(/_1_/, "_2_"))).status).toBe(401);
    expect((await call(appToken, { arguments: { ...fixed, database: "attacker-db" } })).status).toBe(400);
    expect((await call(appToken, { arguments: fixed, extra: true })).status).toBe(400);
    expect((await fetch(`${plane.origin}/api/app-runtime/actions/addPage`, { headers: { authorization: `Bearer ${appToken}` } })).status).toBe(404);
    expect((await fetch(`${plane.origin}/api/app-runtime/actions/../rpc`, { method: "POST", headers: { authorization: `Bearer ${appToken}` } })).status).toBe(404);
    // Each app has a fixed window of action calls shared by all visitors.
    const statuses: number[] = [];
    for (let index = 0; index < 120; index += 1) statuses.push((await call(appToken)).status);
    expect(statuses.filter((status) => status === 200).length).toBe(118);
    expect(statuses.at(-1)).toBe(429);
    expect(pages.calls.filter((args) => JSON.stringify(args) !== JSON.stringify(fixed))).toEqual([]);
  } finally {
    await pages.close();
  }
});
