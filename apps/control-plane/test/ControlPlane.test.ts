import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  controlPlaneProtocolVersion,
  type ControlPlaneClient,
} from "@get-halo/shared/controlPlaneContract";
import { writeWorkspaceServerConnection } from "@get-halo/shared/WorkspaceServerConnection";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import * as errore from "errore";
import { expect, test } from "vitest";
import { ControlPlane } from "../src/server/ControlPlane.js";

const testAuth = {
  secret: "test-control-plane-auth-secret-key!",
  googleClientId: "test-google-client-id.apps.googleusercontent.com",
  googleClientSecret: "test-google-client-secret",
};

const desktopAuthState = "desktop-auth-state-0123456789abcdef";

type ReceivedWorkspaceHeaders = {
  authorization?: string;
  cookie?: string;
};

const controlPlaneTest = test.extend<{
  appDataDir: string;
  authenticatedRpc: ControlPlaneClient;
  browserHeaders: Headers;
  plane: ControlPlane;
  rpc: ControlPlaneClient;
  webRoot: string;
}>({
  appDataDir: async ({ task }, use) => {
    const parent = resolve(import.meta.dirname, "../../../tmp/control-plane");
    await fs.mkdir(parent, { recursive: true });
    const appDataDir = await fs.mkdtemp(join(parent, `${task.id}-`));
    await use(appDataDir);
    await fs.rm(appDataDir, { recursive: true, force: true });
  },
  webRoot: async ({ appDataDir }, use) => {
    const webRoot = join(appDataDir, "web");
    await fs.mkdir(join(webRoot, "assets"), { recursive: true });
    await Promise.all([
      fs.writeFile(join(webRoot, "index.html"), "<main>Halo web app</main>"),
      fs.writeFile(join(webRoot, "assets", "app.js"), "window.Halo = true;"),
    ]);
    await use(webRoot);
  },
  plane: async ({ appDataDir, webRoot }, use) => {
    const plane = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir,
        port: 0,
        auth: testAuth,
      },
      webRoot,
    });
    if (plane instanceof Error) throw plane;
    await use(plane);
    const closed = await plane.close();
    if (closed instanceof Error) console.warn(closed);
  },
  rpc: async ({ plane }, use) => {
    await use(createControlPlaneRpcClient(plane.origin));
  },
  browserHeaders: async ({ appDataDir, plane }, use) => {
    await use(await createAuthenticatedHeaders(appDataDir, plane.origin));
  },
  authenticatedRpc: async ({ browserHeaders, plane, rpc }, use) => {
    const complete = new URL("/api/desktop-auth/complete", plane.origin);
    complete.searchParams.set(
      "callback",
      "http://127.0.0.1:49152/auth/callback",
    );
    complete.searchParams.set("state", desktopAuthState);

    const completion = await fetch(complete, {
      headers: browserHeaders,
      redirect: "manual",
    });
    const location = completion.headers.get("location");
    if (location === null) throw new Error("Desktop sign-in did not complete");
    const code = new URL(location).searchParams.get("code");
    if (code === null) throw new Error("Desktop sign-in did not return a code");

    const session = await rpc.auth.exchange({ code });
    await use(createControlPlaneRpcClient(plane.origin, session.token));
  },
});

controlPlaneTest(
  "stays reachable on loopback until closed",
  async ({ appDataDir, webRoot }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const plane = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir,
        port: 0,
        auth: testAuth,
      },
      webRoot,
    });
    if (plane instanceof Error) throw plane;
    const lifetime = { open: true };
    cleanup.defer(async () => {
      if (!lifetime.open) return;
      const closed = await plane.close();
      if (closed instanceof Error) console.warn(closed);
    });

    const health = await fetch(`${plane.origin}/health`);
    expect(health.status).toBe(200);

    lifetime.open = false;
    const closed = await plane.close();
    if (closed instanceof Error) throw closed;

    const afterClose = await fetch(`${plane.origin}/health`).then(
      () => "answered",
      () => "gone",
    );
    expect(afterClose).toBe("gone");
  },
);

controlPlaneTest(
  "serves browser navigation and built assets",
  async ({ plane }) => {
    const root = await fetch(plane.origin);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await root.text()).toBe("<main>Halo web app</main>");

    const navigation = await fetch(`${plane.origin}/sessions/example`);
    expect(navigation.status).toBe(200);
    expect(await navigation.text()).toBe("<main>Halo web app</main>");

    const asset = await fetch(`${plane.origin}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(await asset.text()).toBe("window.Halo = true;");
  },
);

controlPlaneTest(
  "does not serve the SPA for missing assets or service routes",
  async ({ plane }) => {
    const responses = await Promise.all([
      fetch(`${plane.origin}/assets/missing.js`),
      fetch(`${plane.origin}/api/missing`),
      fetch(`${plane.origin}/rpc/missing`),
      fetch(`${plane.origin}/workspace/missing`),
      fetch(`${plane.origin}/health/missing`),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      404, 404, 404, 401, 404,
    ]);
  },
);

controlPlaneTest(
  "proxies an authenticated browser request to the local workspace",
  async ({ appDataDir, browserHeaders, plane }) => {
    const received: ReceivedWorkspaceHeaders = {};
    const workspaceServer = createServer((request, response) => {
      received.authorization = request.headers.authorization;
      received.cookie = request.headers.cookie;
      response.writeHead(200).end("workspace healthy");
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      workspaceServer.once("error", rejectListen);
      workspaceServer.listen(0, "127.0.0.1", resolveListen);
    });
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(
      async () =>
        await new Promise<void>((resolveClose) => {
          workspaceServer.close(() => resolveClose());
        }),
    );

    // SAFETY: Node returns a TCP address after successfully listening with a numeric port.
    const address = workspaceServer.address() as AddressInfo;
    const published = await writeWorkspaceServerConnection({
      appDataDir,
      connection: {
        workspaceRoot: "/test/workspace",
        origin: `http://127.0.0.1:${address.port}`,
        token: "local-workspace-token",
      },
    });
    if (published instanceof Error) throw published;

    const response = await fetch(`${plane.origin}/workspace/health`, {
      headers: browserHeaders,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("workspace healthy");
    expect(received).toEqual({
      authorization: "Bearer local-workspace-token",
      cookie: undefined,
    });
  },
);

controlPlaneTest("serves Better Auth at /api/auth", async ({ plane }) => {
  const ok = await fetch(`${plane.origin}/api/auth/ok`);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true });
});

controlPlaneTest("serves the typed control-plane RPC", async ({ rpc }) => {
  expect(await rpc.server.info()).toEqual({
    protocolVersion: controlPlaneProtocolVersion,
  });
  expect(await rpc.auth.session()).toBeUndefined();
});

controlPlaneTest(
  "requires authentication to ensure a workspace",
  async ({ rpc }) => {
    await expect(rpc.workspace.ensure()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  },
);

controlPlaneTest(
  "starts Google sign-in in the browser with its state cookie",
  async ({ plane, rpc }) => {
    const result = await rpc.auth.start({
      callback: "http://127.0.0.1:49152/auth/callback",
      state: desktopAuthState,
    });

    const start = new URL(result.authorizationUrl);
    expect(start.origin).toBe(plane.origin);
    expect(start.pathname).toBe("/api/desktop-auth/start");

    const response = await fetch(start, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.getSetCookie()).not.toHaveLength(0);

    const google = new URL(response.headers.get("location")!);
    expect(google.origin).toBe("https://accounts.google.com");
    expect(google.pathname).toBe("/o/oauth2/v2/auth");
  },
);

controlPlaneTest(
  "rejects a desktop callback outside loopback",
  async ({ rpc }) => {
    await expect(
      rpc.auth.start({
        callback: "https://attacker.example/auth/callback",
        state: desktopAuthState,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  },
);

controlPlaneTest(
  "exchanges a one-time code for a bearer session",
  async ({ appDataDir, plane, rpc }) => {
    const browserHeaders = await createAuthenticatedHeaders(
      appDataDir,
      plane.origin,
    );
    const callback = "http://127.0.0.1:49152/auth/callback";
    const complete = new URL("/api/desktop-auth/complete", plane.origin);
    complete.searchParams.set("callback", callback);
    complete.searchParams.set("state", desktopAuthState);

    const completion = await fetch(complete, {
      headers: browserHeaders,
      redirect: "manual",
    });
    expect(completion.status).toBe(302);
    const location = completion.headers.get("location");
    if (location === null) throw new Error("Desktop sign-in did not complete");
    const redirected = new URL(location);
    expect(redirected.origin + redirected.pathname).toBe(callback);
    expect(redirected.searchParams.get("state")).toBe(desktopAuthState);
    const code = redirected.searchParams.get("code");
    if (code === null) throw new Error("Desktop sign-in did not return a code");

    const payload = await rpc.auth.exchange({ code });
    expect(payload.user.email).toBe("desktop@example.com");

    const authenticated = createControlPlaneRpcClient(
      plane.origin,
      payload.token,
    );
    expect(await authenticated.auth.session()).toMatchObject({
      user: { email: "desktop@example.com" },
    });

    await expect(rpc.auth.exchange({ code })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  },
);

controlPlaneTest(
  "ensures one durable workspace for an authenticated user",
  async ({ authenticatedRpc }) => {
    const first = await authenticatedRpc.workspace.ensure();
    const second = await authenticatedRpc.workspace.ensure();

    expect(second).toEqual(first);
    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  },
);

function createControlPlaneRpcClient(origin: string, token?: string) {
  const link = new RPCLink({
    origin,
    url: "/rpc",
    headers:
      token === undefined ? undefined : { authorization: `Bearer ${token}` },
  });
  // SAFETY: The control-plane origin serves controlPlaneContract at /rpc.
  return createORPCClient(link) as ControlPlaneClient;
}

async function createAuthenticatedHeaders(appDataDir: string, origin: string) {
  using database = new DatabaseSync(join(appDataDir, "control-plane.db"));
  const auth = betterAuth({
    baseURL: origin,
    secret: testAuth.secret,
    database,
    plugins: [testUtils()],
  });
  const context = await auth.$context;
  const user = context.test.createUser({
    email: "desktop@example.com",
    name: "Desktop User",
  });
  await context.test.saveUser(user);
  const login = await context.test.login({ userId: user.id });
  return login.headers;
}
