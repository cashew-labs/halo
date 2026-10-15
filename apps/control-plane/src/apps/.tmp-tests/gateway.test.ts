import http from "node:http";
import { expect, vi } from "vitest";
import { appWorldTest, createControlPlaneRpcClient, signIn } from "./appWorld.js";
import { Browser } from "./browser.js";

vi.setConfig({ testTimeout: 60_000 });

/** Raw request, so dot segments and encodings reach the server unnormalized. */
async function raw(ctx: { port: string; host: string; path: string; method?: string; headers?: Record<string, string> }) {
  return await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: Number(ctx.port), path: ctx.path, method: ctx.method ?? "GET", headers: { host: ctx.host, ...ctx.headers } }, (response) => {
      response.resume();
      resolve({ status: response.statusCode!, headers: response.headers });
    });
    request.on("error", reject);
    request.end();
  });
}

async function signInOnCreatorHost(ctx: { browser: Browser; core: string; creator: string; headers: Headers; returnPath?: string }) {
  const { returnPath = "/books/view/" } = ctx;
  // The core session cookie lives only on Halo's origin.
  ctx.browser.setCookies(new URL(ctx.core).host, ctx.headers.get("cookie"));
  const start = await ctx.browser.fetch(`${ctx.creator}/__halo/signin?return=${encodeURIComponent(returnPath)}`);
  expect(start.status).toBe(302);
  const handoff = start.headers.get("location")!;
  expect(handoff.startsWith(`${ctx.core}/api/apps/handoff?`)).toBe(true);
  const page = await ctx.browser.fetch(handoff);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain(`form-action 'self' https://accounts.google.com ${ctx.creator}`);
  const form = new URL(handoff).searchParams;
  const confirmed = await ctx.browser.fetch(`${ctx.core}/api/apps/handoff`, { method: "POST", origin: ctx.core, headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
  expect(confirmed.status).toBe(303);
  const redeem = confirmed.headers.get("location")!;
  expect(redeem.startsWith(`${ctx.creator}/__halo/handoff?code=`)).toBe(true);
  const redeemed = await ctx.browser.fetch(redeem);
  if (returnPath === "/") expect([redeemed.status, await redeemed.text()]).toEqual([200, "Signed in."]);
  else expect([redeemed.status, redeemed.headers.get("location")]).toEqual([302, returnPath]);
  return { page: await page.text(), redeem };
}

appWorldTest("creator hosts serve public apps to anonymous visitors and nothing else", async ({ appDataDir, plane }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
  const port = new URL(plane.origin).port;
  const creator = `http://creator.localhost:${port}`;
  expect(app.url).toBe(`${creator}/books/`);
  const visitor = new Browser();
  try {
    const entry = await visitor.fetch(`${creator}/books`);
    expect([entry.status, entry.headers.get("location")]).toEqual([302, "/books/view/"]);
    const view = await visitor.fetch(`${creator}/books/view/`);
    expect(view.status).toBe(200);
    expect(await view.text()).toContain("Books");
    // Only the gateway's own visitor cookie is set; app responses cannot set cookies.
    expect(view.headers.getSetCookie()).toEqual([expect.stringMatching(/^halo-visitor=[A-Za-z0-9_-]{22}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=31536000$/)]);
    expect(visitor.cookies.get(`creator.localhost:${port}`)?.get("halo-visitor")).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const first = await visitor.api(app.url, "viewer");
    expect(first).toMatchObject({ status: 200, body: { role: "public", viewerId: expect.stringMatching(/^visitor-/) } });
    const viewerId = (first.body as { viewerId: string }).viewerId;
    expect((await visitor.api(app.url, "viewer")).body).toEqual({ viewerId, role: "public" });
    // A new browser is a different pseudonymous visitor.
    const other = new Browser();
    expect((await other.api(app.url, "viewer")).body).not.toMatchObject({ viewerId });
    await other.close();
    // The default read-only declaration lets visitors pull but not push.
    expect((await visitor.fetch(`${creator}/books/sync/pull`, { method: "POST", origin: creator, headers: { "content-type": "application/json" }, body: JSON.stringify({ json: { clientId: "c", cursor: null } }) })).status).not.toBe(403);
    expect((await visitor.fetch(`${creator}/books/sync/push`, { method: "POST", origin: creator, headers: { "content-type": "application/json" }, body: JSON.stringify({ json: {} }) })).status).toBe(403);
    // Workspace tools are unavailable to shared apps.
    expect((await visitor.api(app.url, "manage")).body).toMatchObject({ ok: false });

    // Cross-site writes are refused even with the visitor cookie.
    expect((await visitor.api(app.url, "viewer", undefined, "https://evil.example")).status).toBe(403);
    expect((await visitor.fetch(`${app.url}api/viewer`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);

    // Halo's own routes never answer on a creator host.
    for (const path of ["/rpc/apps/list", "/api/auth/get-session", "/workspace/health", "/api/apps/handoff?host=creator&return=/", "/health", "/", "/books/admin", "/books/rpc/x", "//books/view/", "/books/view/..%2f..%2frpc", "/books/%2e%2e/rpc", "/books/view/../../rpc", "/books/view/%2E%2E/x", "/books\\view/", "/Books/view/"])
      expect([path, (await raw({ port, host: `creator.localhost:${port}`, path })).status]).toEqual([path, 404]);
    expect((await raw({ port, host: `creator.localhost:${port}`, path: "/books/view/", headers: { connection: "upgrade", upgrade: "websocket" } })).status).toBe(404);
    // Unknown creators and apps are indistinguishable.
    expect((await raw({ port, host: `nobody.localhost:${port}`, path: "/books/view/" })).status).toBe(404);
    expect((await raw({ port, host: `creator.localhost:${port}`, path: "/missing/view/" })).status).toBe(404);
  } finally {
    await visitor.close();
  }
});

appWorldTest("signing in to a creator host uses a confirmed single-use handoff, never Halo's cookie", async ({ appDataDir, plane }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "invited", members: ["friend@example.com"] } });
  const core = plane.origin;
  const creator = new URL(app.url).origin;
  const anonymous = new Browser();
  const ownerBrowser = new Browser();
  const friendBrowser = new Browser();
  const strangerBrowser = new Browser();
  try {
    // Invited apps send anonymous viewers to sign in and refuse their API calls.
    const view = await anonymous.fetch(`${creator}/books/view/`);
    expect([view.status, view.headers.get("location")]).toEqual([302, "/__halo/signin?return=%2Fbooks%2Fview%2F"]);
    expect((await anonymous.api(app.url, "viewer")).status).toBe(401);
    // A signed-out person is offered Google sign-in that returns to the handoff.
    const signedOut = await anonymous.fetch(`${core}/api/apps/handoff?host=creator&return=/books/view/&state=sssssssssssssssssssssssssssssssssssssssssss`);
    expect(await signedOut.text()).toContain('action="/api/apps/signin"');
    const google = await anonymous.fetch(`${core}/api/apps/signin`, { method: "POST", origin: core, headers: { "content-type": "application/x-www-form-urlencoded" }, body: "host=creator&return=%2Fbooks%2Fview%2F&state=sssssssssssssssssssssssssssssssssssssssssss" });
    expect(google.status).toBe(303);
    expect(new URL(google.headers.get("location")!).host).toBe("accounts.google.com");
    expect((await anonymous.fetch(`${core}/api/apps/handoff?host=nobody&return=/books/view/&state=sssssssssssssssssssssssssssssssssssssssssss`)).status).toBe(404);
    expect((await anonymous.fetch(`${core}/api/apps/handoff?host=creator&return=//evil.example`)).status).toBe(400);

    // The gateway and Halo's handoff accept the same return paths, including a slashless view and the host root.
    const slashlessView = await anonymous.fetch(`${creator}/books/view`);
    expect([slashlessView.status, slashlessView.headers.get("location")]).toEqual([302, "/__halo/signin?return=%2Fbooks%2Fview"]);
    const invited = await signIn({ appDataDir, origin: plane.origin, email: "returning@example.com" });
    for (const returnPath of ["/books/view", "/"])
      await signInOnCreatorHost({ browser: new Browser(), core, creator, headers: invited.headers, returnPath });
    const signed = await signInOnCreatorHost({ browser: ownerBrowser, core, creator, headers: owner.headers });
    expect(signed.page).toContain("creator@example.com");
    expect(ownerBrowser.cookies.get(new URL(creator).host)?.has("halo-session")).toBe(true);
    // The creator host never receives Halo's own session cookie.
    expect([...(ownerBrowser.cookies.get(new URL(creator).host)?.keys() ?? [])]).toEqual(["halo-session"]);
    expect((await ownerBrowser.api(app.url, "viewer")).body).toMatchObject({ role: "owner", email: "creator@example.com" });
    // A handoff code works once, and only on its own creator host.
    expect((await new Browser().fetch(signed.redeem)).status).toBe(400);
    const forged = new URL(signed.redeem); forged.host = `other.localhost:${forged.port}`;
    expect((await new Browser().fetch(forged.toString())).status).toBe(400);
    // A creator host cannot confirm a handoff on Halo's origin.
    const crossSite = await ownerBrowser.fetch(`${core}/api/apps/handoff`, { method: "POST", origin: creator, headers: { "content-type": "application/x-www-form-urlencoded" }, body: "host=creator&return=%2Fbooks%2Fview%2F&state=sssssssssssssssssssssssssssssssssssssssssss" });
    expect(crossSite.status).toBe(403);

    const friend = await signIn({ appDataDir, origin: core, email: "friend@example.com" });
    await signInOnCreatorHost({ browser: friendBrowser, core, creator, headers: friend.headers });
    expect((await friendBrowser.api(app.url, "viewer")).body).toMatchObject({ role: "member", email: "friend@example.com" });
    const stranger = await signIn({ appDataDir, origin: core, email: "stranger@example.com" });
    await signInOnCreatorHost({ browser: strangerBrowser, core, creator, headers: stranger.headers });
    expect((await strangerBrowser.fetch(`${creator}/books/view/`)).status).toBe(403);
    expect((await strangerBrowser.api(app.url, "viewer")).status).toBe(403);

    // Unpublishing hides the app from everyone but its owner.
    await owner.rpc.apps.update({ appId: app.appId, published: false });
    expect((await friendBrowser.fetch(`${creator}/books/view/`)).status).toBe(404);
    expect((await ownerBrowser.api(app.url, "viewer")).body).toMatchObject({ role: "owner" });
    const out = await ownerBrowser.fetch(`${creator}/__halo/signout`);
    expect(out.status).toBe(200);
    expect(await out.text()).toBe("Signed out.");
    const back = await friendBrowser.fetch(`${creator}/__halo/signout?return=/books/view/`);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/books/view/");
    expect((await friendBrowser.fetch(`${creator}/__halo/signout?return=//evil.example/`)).status).toBe(200);
    // A slashless view path is a valid return path too.
    const slashless = await friendBrowser.fetch(`${creator}/__halo/signout?return=/books/view`);
    expect([slashless.status, slashless.headers.get("location")]).toEqual([302, "/books/view"]);
    // Return paths with control or non-Latin-1 characters fall back safely.
    for (const unsafe of ["%01", "%7F", "%E2%82%AC", "%0D%0ALocation:%20x"])
      expect((await friendBrowser.fetch(`${creator}/__halo/signout?return=/books/view/${unsafe}`)).status).toBe(200);
    expect((await fetch(`${plane.origin}/health`)).status).toBe(200);
    expect((await ownerBrowser.fetch(`${creator}/books/view/`)).status).toBe(404);
  } finally {
    for (const browser of [anonymous, ownerBrowser, friendBrowser, strangerBrowser]) await browser.close();
  }
});

appWorldTest("Halo ignores its cookies on requests from any other origin", async ({ appDataDir, plane }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const headers = new Headers(owner.headers);
  headers.set("x-halo-protocol-version", "6");
  expect(await createControlPlaneRpcClient(plane.origin, headers).auth.session()).toMatchObject({ status: "signed-in" });
  for (const origin of [`http://creator.localhost:${new URL(plane.origin).port}`, "null", "https://evil.example"]) {
    headers.set("origin", origin);
    expect(await createControlPlaneRpcClient(plane.origin, headers).auth.session()).toEqual({ status: "signed-out" });
  }
});

appWorldTest("a handoff code signs in only the browser that started sign-in", async ({ appDataDir, plane }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "invited", members: ["friend@example.com"] } });
  const core = plane.origin;
  const creator = new URL(app.url).origin;
  const attacker = await signIn({ appDataDir, origin: core, email: "friend@example.com" });
  const attackerBrowser = new Browser();
  const victimBrowser = new Browser();
  try {
    // The attacker confirms their own handoff but does not follow the redirect.
    attackerBrowser.setCookies(new URL(core).host, attacker.headers.get("cookie"));
    const start = await attackerBrowser.fetch(`${creator}/__halo/signin?return=/books/view/`);
    expect(start.headers.getSetCookie()).toEqual([expect.stringMatching(/^halo-handoff=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/)]);
    const form = new URL(start.headers.get("location")!).searchParams;
    const confirmed = await attackerBrowser.fetch(`${core}/api/apps/handoff`, { method: "POST", origin: core, headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const redeem = confirmed.headers.get("location")!;
    // A victim without that browser's state, or with its own, is not signed in.
    expect((await victimBrowser.fetch(redeem)).status).toBe(400);
    await victimBrowser.fetch(`${creator}/__halo/signin?return=/books/view/`);
    expect(victimBrowser.cookies.get(new URL(creator).host)?.has("halo-handoff")).toBe(true);
    expect((await victimBrowser.fetch(redeem)).status).toBe(400);
    expect(victimBrowser.cookies.get(new URL(creator).host)?.has("halo-session")).toBe(false);
    // The failed attempts did not use up the code for the browser that owns it.
    const redeemed = await attackerBrowser.fetch(redeem);
    expect(redeemed.status).toBe(302);
    expect(redeemed.headers.getSetCookie()).toEqual([expect.stringMatching(/^halo-session=/), expect.stringMatching(/^halo-handoff=; .*Max-Age=0$/)]);
    expect((await attackerBrowser.api(app.url, "viewer")).body).toMatchObject({ role: "member" });
  } finally {
    await attackerBrowser.close();
    await victimBrowser.close();
  }
});

appWorldTest("an app VM that fails mid-response ends the visitor's response", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
  // Sends headers and part of a body, then drops the connection.
  const broken = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "content-length": "1000" });
    response.write("<main>partial", () => response.socket?.destroy());
  });
  await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
  const { port } = broken.address() as { port: number };
  provider.origins.set(app.appId, `http://127.0.0.1:${port}`);
  try {
    const result = await new Promise<{ status: number; error: string | undefined }>((resolve) => {
      const request = http.request({ host: "127.0.0.1", port: Number(new URL(plane.origin).port), path: "/books/view/", headers: { host: new URL(app.url).host } }, (response) => {
        response.on("error", (error) => resolve({ status: response.statusCode!, error: error.message }));
        response.on("end", () => resolve({ status: response.statusCode!, error: undefined }));
        response.on("close", () => resolve({ status: response.statusCode!, error: "closed" }));
        response.resume();
      });
      request.end();
    });
    expect(result.status).toBe(200);
    expect(result.error).toBeDefined();
  } finally {
    provider.origins.delete(app.appId);
    await new Promise((resolve) => broken.close(resolve));
  }
});

appWorldTest("a creator-host request that throws inside the gateway answers 500 and the control plane keeps serving", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
  const original = provider.getConnection.bind(provider);
  provider.getConnection = async () => { throw new Error("provider bug"); };
  const visitor = new Browser();
  try {
    expect((await visitor.fetch(`${app.url}view/`)).status).toBe(500);
    expect((await fetch(`${plane.origin}/health`)).status).toBe(200);
  } finally {
    provider.getConnection = original;
    await visitor.close();
  }
});
