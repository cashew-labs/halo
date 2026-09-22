import { gzipSync } from "node:zlib";
import { TraceCloudDriver } from "./TraceCloudDriver.js";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  controlPlaneProtocolVersion,
  type ControlPlaneClient,
} from "@get-halo/shared/controlPlaneContract";
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

const controlPlaneTest = test.extend<{
  traceCloud: TraceCloudDriver;
  appDataDir: string;
  authenticatedRpc: ControlPlaneClient;
  browserHeaders: Headers;
  plane: ControlPlane;
  rpc: ControlPlaneClient;
  webRoot: string;
}>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest requires destructured fixture parameters.
  traceCloud: async ({}, use) => {
    const cloud = await TraceCloudDriver.start();
    await use(cloud);
    await cloud.close();
  },
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
  plane: async ({ appDataDir, webRoot, traceCloud }, use) => {
    const plane = await ControlPlane.start({
      build: { version: "test-release", revision: "test-revision" },
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir,
        port: 0,
        auth: testAuth,
      },
      webRoot,
      traceCloud: traceCloud.cloud(),
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

controlPlaneTest("serves Better Auth at /api/auth", async ({ plane }) => {
  const ok = await fetch(`${plane.origin}/api/auth/ok`);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true });
});

controlPlaneTest("serves the typed control-plane RPC", async ({ rpc }) => {
  expect(await rpc.server.info()).toEqual({
    protocolVersion: controlPlaneProtocolVersion,
    supportedProtocols: [controlPlaneProtocolVersion],
    build: { version: "test-release", revision: "test-revision" },
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
  "starts Google sign-in in the browser without opening the website",
  async ({ plane, rpc }) => {
    const result = await rpc.auth.start({
      callback: "http://127.0.0.1:49152/auth/callback",
      state: desktopAuthState,
    });

    const google = new URL(result.authorizationUrl);
    expect(google.origin).toBe("https://accounts.google.com");
    expect(google.pathname).toBe("/o/oauth2/v2/auth");
    expect(google.searchParams.get("client_id")).toBe(testAuth.googleClientId);
    expect(google.searchParams.get("redirect_uri")).toBe(
      `${plane.origin}/api/auth/callback/google`,
    );
  },
);

controlPlaneTest(
  "keeps the desktop start page as a Google redirect",
  async ({ plane }) => {
    const start = new URL("/api/desktop-auth/start", plane.origin);
    start.searchParams.set("callback", "http://127.0.0.1:49152/auth/callback");
    start.searchParams.set("state", desktopAuthState);

    const response = await fetch(start, { redirect: "manual" });
    expect(response.status).toBe(302);

    const google = new URL(response.headers.get("location")!);
    expect(google.origin).toBe("https://accounts.google.com");
    expect(google.pathname).toBe("/o/oauth2/v2/auth");
  },
);

controlPlaneTest(
  "does not send OAuth errors to the website homepage",
  async ({ plane }) => {
    const response = await fetch(`${plane.origin}/api/auth/callback/google`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${plane.origin}/api/desktop-auth/error?error=state_not_found`,
    );

    const error = await fetch(
      `${plane.origin}/api/desktop-auth/error?error=state_not_found`,
    );
    expect(error.status).toBe(200);
    const body = await error.text();
    expect(body).toContain("state_not_found");
    expect(body).not.toContain("Halo web app");
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

function createControlPlaneRpcClient(origin: string, token?: string | Headers) {
  const link = new RPCLink({
    origin,
    url: "/rpc",
    headers:
      token instanceof Headers
        ? token
        : token === undefined
          ? undefined
          : { authorization: `Bearer ${token}` },
  });
  // SAFETY: The control-plane origin serves controlPlaneContract at /rpc.
  return createORPCClient(link) as ControlPlaneClient;
}

async function createAuthenticatedHeaders(
  appDataDir: string,
  origin: string,
  email = "desktop@example.com",
) {
  using database = new DatabaseSync(join(appDataDir, "control-plane.db"));
  const auth = betterAuth({
    baseURL: origin,
    secret: testAuth.secret,
    database,
    plugins: [testUtils()],
  });
  const context = await auth.$context;
  const user = context.test.createUser({
    email,
    name: "Desktop User",
  });
  await context.test.saveUser(user);
  const login = await context.test.login({ userId: user.id });
  return login.headers;
}

controlPlaneTest(
  "isolates trace uploads by verified VM identity and preserves immutable retries",
  async ({ plane, traceCloud, authenticatedRpc, appDataDir }) => {
    const alice = await authenticatedRpc.workspace.ensure();
    const bobHeaders = await createAuthenticatedHeaders(
      appDataDir,
      plane.origin,
      "bob@example.com",
    );
    const bob = await createControlPlaneRpcClient(
      plane.origin,
      bobHeaders,
    ).workspace.ensure();
    traceCloud.instances.set(alice.id, "101");
    traceCloud.instances.set(bob.id, "202");
    const traceId = "a".repeat(32);
    const endpoint = `${plane.origin}/api/traces/conversation/${traceId}`;
    const send = async (
      workspaceId: string,
      body: Buffer,
      suffix = "",
      extraHeaders = {},
    ) =>
      await fetch(endpoint + suffix, {
        method: "POST",
        headers: {
          authorization: `Bearer ${traceCloud.token({ origin: plane.origin, workspaceId })}`,
          "content-type": "application/gzip",
          ...extraHeaders,
        },
        body,
      });
    const aliceArchive = traceArchive(alice.id, traceId);
    const bobArchive = traceArchive(bob.id, traceId);
    expect((await send(alice.id, bobArchive)).status).toBe(400);
    expect(
      (await send(alice.id, aliceArchive, `?workspaceId=${bob.id}`)).status,
    ).toBe(400);
    expect(traceCloud.uploads).toHaveLength(0);
    expect(
      (
        await send(alice.id, aliceArchive, "", {
          "x-workspace-id": bob.id,
          "x-user-id": "bob",
        })
      ).status,
    ).toBe(204);
    expect((await send(bob.id, bobArchive)).status).toBe(204);
    const aliceKey = `v1/workspaces/${alice.id}/sessions/conversation/${traceId}.jsonl.gz`;
    const bobKey = `v1/workspaces/${bob.id}/sessions/conversation/${traceId}.jsonl.gz`;
    expect(traceCloud.objects.get(aliceKey)).toEqual(aliceArchive);
    expect(traceCloud.objects.get(bobKey)).toEqual(bobArchive);
    expect(
      (await send(alice.id, traceArchive(alice.id, traceId, "modified")))
        .status,
    ).toBe(204);
    expect(traceCloud.objects.get(aliceKey)).toEqual(aliceArchive);
    traceCloud.nextUploadStatus = 503;
    expect((await send(alice.id, aliceArchive)).status).toBe(503);
    expect((await send(alice.id, aliceArchive)).status).toBe(204);
    expect(traceCloud.objects.size).toBe(2);
    expect(
      traceCloud.uploads.every(
        (upload) =>
          upload.precondition === "0" &&
          upload.authorization === "Bearer control-plane-storage-token",
      ),
    ).toBe(true);
  },
);

controlPlaneTest(
  "rejects invalid, shared-only, foreign, expired and replaced VM identities before storage",
  async ({ plane, traceCloud, authenticatedRpc }) => {
    const workspace = await authenticatedRpc.workspace.ensure();
    traceCloud.instances.set(workspace.id, "101");
    const traceId = "b".repeat(32);
    const endpoint = `${plane.origin}/api/traces/conversation/${traceId}`;
    const body = traceArchive(workspace.id, traceId);
    const token = (
      claims: Parameters<TraceCloudDriver["token"]>[0]["claims"] = {},
    ) =>
      traceCloud.token({
        origin: plane.origin,
        workspaceId: workspace.id,
        claims,
      });
    const send = async (credential: string) =>
      await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/gzip",
        },
        body,
      });
    expect((await fetch(endpoint, { method: "POST", body })).status).toBe(401);
    for (const credential of [
      "invalid",
      token({ aud: "https://other.example/api/traces" }),
      token({ iss: "https://other.example" }),
      token({ iat: 1, exp: 2 }),
      token({ google: undefined }),
      token({ email_verified: false }),
      token({ email: "another@trace-project.iam.gserviceaccount.com" }),
      token({
        google: {
          compute_engine: {
            project_id: "foreign-project",
            zone: "us-west2-a",
            instance_id: "101",
            instance_name: `halo-${workspace.id}`,
          },
        },
      }),
      token({
        google: {
          compute_engine: {
            project_id: "trace-project",
            zone: "us-east1-a",
            instance_id: "101",
            instance_name: `halo-${workspace.id}`,
          },
        },
      }),
    ])
      expect((await send(credential)).status).toBe(401);
    const valid = token();
    const pieces = valid.split(".");
    const forgedPayload = Buffer.from(
      `${Buffer.from(pieces[1]!, "base64url").toString("utf8")} `,
    ).toString("base64url");
    expect(
      (await send(`${pieces[0]}.${forgedPayload}.${pieces[2]}`)).status,
    ).toBe(401);
    traceCloud.instances.set(workspace.id, "999");
    expect((await send(valid)).status).toBe(401);
    traceCloud.instances.delete(workspace.id);
    expect((await send(valid)).status).toBe(401);
    const unregistered = "11111111-1111-4111-8111-111111111111";
    traceCloud.instances.set(unregistered, "303");
    expect(
      (
        await send(
          traceCloud.token({ origin: plane.origin, workspaceId: unregistered }),
        )
      ).status,
    ).toBe(403);
    expect(traceCloud.uploads).toHaveLength(0);
  },
);

controlPlaneTest(
  "rejects unsafe paths, oversized or malformed archives and mismatched record identities",
  async ({ plane, traceCloud, authenticatedRpc }) => {
    const workspace = await authenticatedRpc.workspace.ensure();
    traceCloud.instances.set(workspace.id, "101");
    const traceId = "c".repeat(32);
    const headers = {
      authorization: `Bearer ${traceCloud.token({ origin: plane.origin, workspaceId: workspace.id })}`,
      "content-type": "application/gzip",
    };
    for (const path of [
      `/api/traces/%2e%2e%2fother/${traceId}`,
      `/api/traces/conversation/${traceId}/extra`,
      `/api/traces/conversation/not-a-trace`,
    ]) {
      expect(
        (
          await fetch(plane.origin + path, {
            method: "POST",
            headers,
            body: traceArchive(workspace.id, traceId),
          })
        ).status,
      ).toBe(400);
    }
    for (const body of [
      Buffer.from("not gzip"),
      gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1)),
      gzipSync("not json\n"),
      traceArchive(workspace.id, "d".repeat(32)),
      gzipSync("{}\n"),
      gzipSync("{}"),
    ]) {
      expect(
        (
          await fetch(`${plane.origin}/api/traces/conversation/${traceId}`, {
            method: "POST",
            headers,
            body,
          })
        ).status,
      ).toBe(400);
    }
    expect(traceCloud.uploads).toHaveLength(0);
  },
);

function traceArchive(
  workspaceId: string,
  traceId: string,
  content = "original",
) {
  return gzipSync(
    ["run.started", "run.finished"]
      .map((type, sequence) =>
        JSON.stringify({
          schemaVersion: 1,
          workspaceId,
          sessionId: "conversation",
          traceId,
          spanId: "1".repeat(16),
          sequence,
          timestamp: new Date(0).toISOString(),
          type,
          data: { content },
        }),
      )
      .join("\n") + "\n",
  );
}

controlPlaneTest(
  "rejects unsupported protocols before provisioning",
  async ({ plane, browserHeaders }) => {
    const headers = new Headers(browserHeaders);
    headers.set("x-halo-protocol-version", "999");
    const rpc = createORPCClient<ControlPlaneClient>(
      new RPCLink({
        origin: plane.origin,
        url: "/rpc",
        headers: Object.fromEntries(headers),
      }),
    );
    expect(await rpc.server.info()).toMatchObject({
      supportedProtocols: [controlPlaneProtocolVersion],
    });
    await expect(rpc.workspace.ensure()).rejects.toMatchObject({
      code: "UNSUPPORTED_PROTOCOL",
    });
  },
);
