import { gzipSync } from "node:zlib";
import { TraceCloudDriver } from "./TraceCloudDriver.js";
import fs from "node:fs/promises";
import http from "node:http";
import events from "node:events";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { writeWorkspaceServerConnection } from "@get-halo/shared/WorkspaceServerConnection";
import { type ControlPlaneClient } from "@get-halo/shared/controlPlaneContract";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import * as errore from "errore";
import { expect, test } from "vitest";
import { ControlPlane } from "../src/server/ControlPlane.js";
import { LocalWorkspaceProvider } from "../src/workspace/provider/local/LocalWorkspaceProvider.js";
import type { WorkspaceProviderApi } from "../src/workspace/provider/WorkspaceProviderApi.js";
import {
  workspaceRuntimeConfigFileName,
  workspaceRuntimeConfigSchema,
} from "@get-halo/config/workspaceServer";
import { Value } from "@sinclair/typebox/value";
import {
  togetherModel,
  workspaceInferencePath,
} from "@get-halo/config/inference";

/** External workspace HTTP hosts, discovered through the real local provider. */
class WorkspaceHostDriver {
  readonly provider: LocalWorkspaceProvider;
  private readonly server: http.Server;

  private constructor(ctx: { appDataDir: string }) {
    this.provider = new LocalWorkspaceProvider(ctx);
    this.server = http.createServer((request, response) => {
      if (request.headers.authorization !== "Bearer test-workspace-token") {
        response.writeHead(401).end();
        return;
      }
      if (request.url === "/headers") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(request.headers));
        return;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ workspace: "test-workspace" }));
    });
  }

  static async start(ctx: { appDataDir: string }) {
    await using cleanup = new errore.AsyncDisposableStack();
    const host = new WorkspaceHostDriver(ctx);
    host.server.listen(0, "127.0.0.1");
    await events.once(host.server, "listening");
    cleanup.defer(async () => await host.close());
    // SAFETY: The TCP listener is ready before the address is read.
    const address = host.server.address() as AddressInfo;
    await fs.mkdir(ctx.appDataDir, { recursive: true });
    const published = await writeWorkspaceServerConnection({
      appDataDir: ctx.appDataDir,
      connection: {
        workspaceRoot: ctx.appDataDir,
        origin: `http://127.0.0.1:${address.port}`,
        token: "test-workspace-token",
      },
    });
    if (published instanceof Error) throw published;
    cleanup.move();
    return host;
  }

  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((complete, reject) => {
      this.server.close((error) =>
        error === undefined ? complete() : reject(error),
      );
    });
  }
}

const testAuth = {
  secret: "test-control-plane-auth-secret-key!",
  googleClientId: "test-google-client-id.apps.googleusercontent.com",
  googleClientSecret: "test-google-client-secret",
};

const desktopAuthState = "desktop-auth-state-0123456789abcdef";

const controlPlaneTest = test.extend<{
  traceCloud: TraceCloudDriver;
  inferenceApiKey: string | undefined;
  appDataDir: string;
  authenticatedRpc: ControlPlaneClient;
  browserHeaders: Headers;
  plane: ControlPlane;
  rpc: ControlPlaneClient;
  webRoot: string;
  workspaceProvider: WorkspaceProviderApi;
  workspaceHost: WorkspaceHostDriver;
}>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  inferenceApiKey: async ({}, use) => {
    await use(process.env.HALO_TEST_TOGETHER_API_KEY);
  },
  workspaceProvider: async ({ appDataDir }, use) => {
    await use(new LocalWorkspaceProvider({ appDataDir }));
  },
  workspaceHost: async ({ appDataDir }, use) => {
    const host = await WorkspaceHostDriver.start({
      appDataDir: join(appDataDir, "upstream"),
    });
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await host.close());
    await use(host);
  },
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest requires destructured fixture parameters.
  traceCloud: async ({}, use) => {
    const cloud = new TraceCloudDriver();
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
  plane: async (
    { appDataDir, webRoot, traceCloud, workspaceProvider, inferenceApiKey },
    use,
  ) => {
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
      workspaceProvider,
      traceCloud: traceCloud.cloud(),
      inferenceApiKey,
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
  "requires authentication to ensure a workspace",
  async ({ rpc }) => {
    await expect(rpc.workspace.ensure()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
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

async function readRuntimeSettings(appDataDir: string) {
  const runtime: unknown = JSON.parse(
    await fs.readFile(join(appDataDir, workspaceRuntimeConfigFileName), "utf8"),
  );
  if (!Value.Check(workspaceRuntimeConfigSchema, runtime))
    throw new Error("Invalid assigned workspace service settings");
  return runtime;
}

controlPlaneTest(
  "derives workspace identity from its key and revokes the old key on rotation",
  async ({ plane, authenticatedRpc, appDataDir }) => {
    const alice = await authenticatedRpc.workspace.ensure();
    const aliceRuntime = await readRuntimeSettings(appDataDir);
    const bobHeaders = await createAuthenticatedHeaders(
      appDataDir,
      plane.origin,
      "runtime-bob@example.com",
    );
    const bobRpc = createControlPlaneRpcClient(plane.origin, bobHeaders);
    const bob = await bobRpc.workspace.ensure();
    const bobRuntime = await readRuntimeSettings(appDataDir);
    expect(bobRuntime.token).not.toBe(aliceRuntime.token);
    const identify = async (token: string) =>
      await fetch(
        `${plane.origin}/api/workspace-runtime/identity?workspaceId=${bob.id}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            "x-halo-workspace-id": bob.id,
          },
        },
      );
    expect(await (await identify(aliceRuntime.token)).json()).toEqual({
      workspaceId: alice.id,
    });
    expect(await (await identify(bobRuntime.token)).json()).toEqual({
      workspaceId: bob.id,
    });
    expect(await authenticatedRpc.workspace.rotateRuntimeToken()).toEqual(
      alice,
    );
    const rotated = await readRuntimeSettings(appDataDir);
    expect(rotated.token).not.toBe(aliceRuntime.token);
    expect(rotated.generation).toBe(2);
    expect((await identify(aliceRuntime.token)).status).toBe(401);
    expect(await (await identify(rotated.token)).json()).toEqual({
      workspaceId: alice.id,
    });
    expect(await (await identify(bobRuntime.token)).json()).toEqual({
      workspaceId: bob.id,
    });
  },
);

controlPlaneTest(
  "restricts inference to workspace keys, the configured model, and bounded streaming requests",
  async ({ plane, authenticatedRpc, browserHeaders, appDataDir }) => {
    await authenticatedRpc.workspace.ensure();
    const runtime = await readRuntimeSettings(appDataDir);
    const endpoint = `${plane.origin}${workspaceInferencePath}/chat/completions`;
    const body = {
      model: togetherModel.id,
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    };
    const headers = {
      authorization: `Bearer ${runtime.token}`,
      "content-type": "application/json",
    };
    for (const rejectedHeaders of [browserHeaders, new Headers()]) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: rejectedHeaders,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(401);
    }
    for (const invalid of [
      { ...body, model: "some-other-model" },
      { ...body, stream: false },
      { ...body, messages: [] },
      { ...body, max_tokens: togetherModel.maxTokens + 1 },
    ]) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(invalid),
      });
      expect(response.status).toBe(400);
    }
    const malformed = await fetch(endpoint, {
      method: "POST",
      headers,
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const oversized = await fetch(endpoint, {
      method: "POST",
      headers,
      body: "x".repeat(16 * 1024 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    const wrongType = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: headers.authorization },
      body: "text",
    });
    expect(wrongType.status).toBe(415);
    expect((await fetch(endpoint, { headers })).status).toBe(405);
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
  "rejects missing, invalid, browser-session and rotated credentials for trace uploads",
  async ({ plane, authenticatedRpc, appDataDir, browserHeaders }) => {
    const workspace = await authenticatedRpc.workspace.ensure();
    const runtime = await readRuntimeSettings(appDataDir);
    const endpoint = `${plane.origin}/api/traces/conversation/${"b".repeat(32)}`;
    const body = traceArchive(workspace.id, "b".repeat(32));
    for (const headers of [
      new Headers(),
      new Headers({ authorization: "Bearer invalid" }),
      browserHeaders,
    ]) {
      const response = await fetch(endpoint, { method: "POST", headers, body });
      expect(response.status).toBe(401);
    }
    await authenticatedRpc.workspace.rotateRuntimeToken();
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${runtime.token}`,
            "content-type": "application/gzip",
          },
          body,
        })
      ).status,
    ).toBe(401);
  },
);

controlPlaneTest(
  "rejects unsafe paths, oversized or malformed archives and mismatched record identities",
  async ({ plane, authenticatedRpc, appDataDir }) => {
    const workspace = await authenticatedRpc.workspace.ensure();
    const runtime = await readRuntimeSettings(appDataDir);
    const traceId = "c".repeat(32);
    const headers = {
      authorization: `Bearer ${runtime.token}`,
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
