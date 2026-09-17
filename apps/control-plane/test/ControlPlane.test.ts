import fs from "node:fs/promises";
import { once } from "node:events";
import http, { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
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
  forwarded?: string;
  host?: string;
  origin?: string;
  xForwardedHost?: string;
  xForwardedProto?: string;
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
    expect(root.headers.get("cache-control")).toBe("no-cache");
    expect(root.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(root.headers.get("content-security-policy")).toContain(
      "frame-src 'self'",
    );
    expect(root.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await root.text()).toBe("<main>Halo web app</main>");

    const navigation = await fetch(`${plane.origin}/sessions/example`);
    expect(navigation.status).toBe(200);
    expect(navigation.headers.get("cache-control")).toBe("no-cache");
    expect(await navigation.text()).toBe("<main>Halo web app</main>");

    const asset = await fetch(`${plane.origin}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
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
  "rejects unauthenticated workspace WebSocket upgrades",
  async ({ plane }) => {
    expect(
      await requestUpgrade(
        `${plane.origin}/workspace/extensions/editor/view/`,
        {
          origin: plane.origin,
        },
      ),
    ).toEqual({ type: "response", statusCode: 401 });
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

controlPlaneTest(
  "proxies authenticated WebSocket upgrades to the local workspace",
  async ({ appDataDir, browserHeaders, plane }) => {
    const received: ReceivedWorkspaceHeaders & { url?: string } = {};
    let workspaceSocket: Duplex | undefined;
    const workspaceServer = createServer();
    workspaceServer.on("upgrade", (request, socket) => {
      workspaceSocket = socket;
      received.authorization = request.headers.authorization;
      received.cookie = request.headers.cookie;
      received.forwarded = request.headers.forwarded;
      received.host = request.headers.host;
      received.origin = request.headers.origin;
      received.xForwardedHost = request.headers["x-forwarded-host"] as
        | string
        | undefined;
      received.xForwardedProto = request.headers["x-forwarded-proto"] as
        | string
        | undefined;
      received.url = request.url;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n\r\n" +
          "workspace-ready\n",
      );
      socket.on("data", (data) => socket.write(data));
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

    const origin = new URL(plane.origin);
    const result = await requestUpgrade(
      `${plane.origin}/workspace/extensions/editor/view/socket?channel=editor`,
      {
        ...Object.fromEntries(browserHeaders.entries()),
        forwarded: "host=attacker.example;proto=http",
        origin: plane.origin,
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
      },
    );
    if (result.type === "response")
      throw new Error(`WebSocket upgrade returned ${result.statusCode}`);
    cleanup.defer(() => {
      result.socket.destroy();
      workspaceSocket?.destroy();
    });

    expect(await readUpgradeLine(result.socket, result.head)).toBe(
      "workspace-ready",
    );
    expect(received).toEqual({
      authorization: "Bearer local-workspace-token",
      cookie: undefined,
      forwarded: undefined,
      host: origin.host,
      origin: plane.origin,
      url: "/extensions/editor/view/socket?channel=editor",
      xForwardedHost: origin.host,
      xForwardedProto: "http",
    });

    result.socket.write("browser-message");
    const [echoed] = await once(result.socket, "data");
    expect(echoed.toString()).toBe("browser-message");
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
  expect(await rpc.auth.session()).toEqual({ status: "signed-out" });
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
      status: "signed-in",
      session: { user: { email: "desktop@example.com" } },
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

async function requestUpgrade(url: string, headers: IncomingHttpHeaders) {
  return await new Promise<
    | { type: "response"; statusCode: number | undefined }
    | { type: "upgrade"; head: Buffer; socket: Duplex }
  >((resolveRequest, rejectRequest) => {
    const request = http.request(url, {
      headers: {
        ...headers,
        connection: "Upgrade",
        "sec-websocket-key": "dGVzdC13ZWJzb2NrZXQta2V5",
        "sec-websocket-version": "13",
        upgrade: "websocket",
      },
    });
    request.once("upgrade", (_response, socket, head) => {
      resolveRequest({ type: "upgrade", socket, head });
    });
    request.once("response", (response) => {
      response.resume();
      resolveRequest({ type: "response", statusCode: response.statusCode });
    });
    request.once("error", rejectRequest);
    request.end();
  });
}

async function readUpgradeLine(socket: Duplex, head: Buffer) {
  const chunks = [head];
  while (!Buffer.concat(chunks).includes(10)) {
    const [chunk] = await once(socket, "data");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString().split("\n")[0]!;
}
