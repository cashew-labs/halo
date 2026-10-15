import http from "node:http";
import { expect, vi } from "vitest";
import { appWorldTest, signIn } from "./appWorld.js";
import { Browser } from "./browser.js";
import { connectPages, startPagesApi } from "./pagesApi.js";

vi.setConfig({ testTimeout: 120_000 });

async function send(ctx: { url: string; method: string; headers?: Record<string, string>; body?: string }) {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request(ctx.url, { method: ctx.method, headers: ctx.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
    request.end(ctx.body);
  });
}

appWorldTest("the gateway reports unreachable apps and rejects malformed sign-in and action requests", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
  const visitor = new Browser();
  try {
    // A VM that is booting answers 503; one whose server is down answers 502.
    provider.unreachable.add(app.appId);
    expect((await visitor.fetch(`${app.url}view/`)).status).toBe(503);
    provider.unreachable.delete(app.appId);
    provider.brokenOrigins.add(app.appId);
    expect((await visitor.fetch(`${app.url}view/`)).status).toBe(502);
    provider.brokenOrigins.delete(app.appId);
    expect((await visitor.fetch(`${app.url}view/`)).status).toBe(200);

    const handoff = `${plane.origin}/api/apps/handoff`;
    expect((await send({ url: `${handoff}?host=creator&return=/books/view/&state=sssssssssssssssssssssssssssssssssssssssssss`, method: "PUT" })).status).toBe(405);
    expect((await send({ url: `${plane.origin}/api/apps/signin?host=creator&return=/books/view/&state=sssssssssssssssssssssssssssssssssssssssssss`, method: "GET" })).status).toBe(405);
    expect((await send({ url: handoff, method: "POST", headers: { origin: plane.origin, "content-type": "application/json" }, body: "{}" })).status).toBe(400);
    expect((await send({ url: handoff, method: "POST", headers: { origin: plane.origin, "content-type": "application/x-www-form-urlencoded" }, body: "x".repeat(5000) })).status).toBe(400);
    // Confirming needs a Halo session.
    expect((await send({ url: handoff, method: "POST", headers: { origin: plane.origin, "content-type": "application/x-www-form-urlencoded" }, body: "host=creator&return=%2Fbooks%2Fview%2F&state=sssssssssssssssssssssssssssssssssssssssssss" })).status).toBe(401);
    // Page text is escaped, including the return path.
    const page = await send({ url: `${handoff}?host=creator&return=${encodeURIComponent('/books/view/?a=1&b=2')}&state=sssssssssssssssssssssssssssssssssssssssssss`, method: "GET" });
    expect(page.body).toContain("/books/view/?a=1&amp;b=2");
    // Return paths outside the creator host's URL-safe set are refused.
    expect((await send({ url: `${handoff}?host=creator&return=${encodeURIComponent('/books/view/?b="<x>')}&state=sssssssssssssssssssssssssssssssssssssssssss`, method: "GET" })).status).toBe(400);
    expect(page.body).not.toContain('"<x>');

    // App runtime requests must be bounded JSON with known fields.
    const token = provider.vms.get(app.appId)!.assignment.runtime.token;
    const action = `${plane.origin}/api/app-runtime/actions/addPage`;
    expect((await send({ url: action, method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{" })).status).toBe(400);
    expect((await send({ url: action, method: "POST", headers: { authorization: `Bearer ${token}` }, body: "x".repeat(70_000) })).status).toBe(400);
    expect((await send({ url: action, method: "POST", headers: { authorization: `Bearer ${token}` }, body: "" })).status).toBe(400);
  } finally {
    await visitor.close();
  }
});

appWorldTest("a cancelled app's credential stops working", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  provider.failAppEnsures = 1;
  await expect(owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } })).rejects.toBeDefined();
  const [pending] = await owner.rpc.apps.list();
  const token = provider.assignments.find((assignment) => assignment.sharedApp?.appId === pending!.appId)!.runtime.token;
  await owner.rpc.apps.cancel({ appId: pending!.appId });
  expect((await send({ url: `${plane.origin}/api/app-runtime/actions/addPage`, method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" })).status).toBe(401);
});

appWorldTest.extend({ router: `addPage: os.handler(({ context }) => context.tools.actions.addPage({})), failPage: os.handler(({ context }) => context.tools.actions.failPage({})),` })("app code sees action failures and the shared limit as tool errors", async ({ appDataDir, plane, provider }) => {
  const pages = await startPagesApi();
  const visitor = new Browser();
  try {
    const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
    await owner.rpc.workspace.ensure();
    const { address } = await connectPages({ owner, endpoint: pages.endpoint, origin: plane.origin, provider });
    const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
    await owner.rpc.apps.bindActions({ appId: app.appId, actions: [{ name: "addPage", description: "Add", address, arguments: { database: "reading-db", title: "x" } }, { name: "failPage", description: "Fails", address, arguments: { database: "failing-db", title: "x" } }] });
    expect((await visitor.api(app.url, "failPage")).body).toMatchObject({ ok: false, error: { code: "failed" } });
    const token = provider.vms.get(app.appId)!.assignment.runtime.token;
    for (let index = 0; index < 119; index += 1) await send({ url: `${plane.origin}/api/app-runtime/actions/addPage`, method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
    expect((await visitor.api(app.url, "addPage")).body).toMatchObject({ ok: false, error: { code: "rate_limited", retryable: true } });
  } finally {
    await visitor.close();
    await pages.close();
  }
});
