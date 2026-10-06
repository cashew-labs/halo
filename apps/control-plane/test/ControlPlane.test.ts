import { gzipSync } from "node:zlib";
import {
  AuthTemplateSlug,
  ConnectionName,
  Effect,
  IntegrationSlug,
  Owner,
  ToolAddress,
} from "@executor-js/sdk/core";
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
import {
  controlPlaneProtocolVersion,
  type ControlPlaneClient,
} from "@get-halo/shared/controlPlaneContract";
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

const integrationEncryptionKey = Buffer.alloc(32, 17);
// Only Google's external Discovery HTTP boundary is replaced. Executor parses,
// installs and persists the document through its real OpenAPI plugin.
const getOpenAPISpec = async (_url: string) =>
  JSON.stringify({
    discoveryVersion: "v1",
    id: "test:v1",
    name: "test",
    version: "v1",
    title: "Test Google API",
    rootUrl: "https://example.invalid/",
    servicePath: "test/v1/",
    resources: {
      documents: {
        methods: {
          list: {
            id: "test.documents.list",
            path: "documents",
            httpMethod: "GET",
            response: { type: "object" },
          },
        },
      },
    },
  });

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
  integrationApi: {
    origin: string;
    requests: { url: string | undefined; authorization: string | undefined }[];
  };
}>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  integrationApi: async ({}, use) => {
    const requests: {
      url: string | undefined;
      authorization: string | undefined;
    }[] = [];
    const server = http.createServer((request, response) => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
      });
      if (request.url !== "/items") {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ items: ["fixture-item"] }));
    });
    server.listen(0, "127.0.0.1");
    await events.once(server, "listening");
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) =>
          error === undefined ? resolveClose() : reject(error),
        ),
      );
    });
    // SAFETY: A listening TCP server has AddressInfo, not a pipe address.
    const address = server.address() as AddressInfo;
    await use({ origin: `http://127.0.0.1:${address.port}`, requests });
  },
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
      integrationEncryptionKey,
      getOpenAPISpec,
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
  "persists user-bound integration catalogs and native policies after restart",
  async ({ appDataDir, webRoot, workspaceProvider, integrationApi }) => {
    const databaseUrl = process.env.HALO_TEST_POSTGRES_URL;
    const config =
      databaseUrl === undefined
        ? {
            deployment: "local" as const,
            workspace: { deployment: "local" as const },
            appDataDir,
            port: 0,
            auth: testAuth,
          }
        : {
            deployment: "cloudRun" as const,
            workspace: {
              deployment: "gcp" as const,
              instanceTemplate: "test",
              projectId: "test",
              zone: "test",
            },
            port: 0,
            auth: testAuth,
            databaseUrl,
            origin: "https://control-plane.example.invalid",
            traceBucket: "test",
            workspaceServiceAccount: "test",
          };
    const plane = await ControlPlane.start({
      config,
      webRoot,
      workspaceProvider,
      integrationEncryptionKey,
      getOpenAPISpec,
    });
    if (plane instanceof Error) throw plane;
    await using cleanup = new errore.AsyncDisposableStack();
    const lifetime = { open: true };
    cleanup.defer(async () => {
      if (lifetime.open) {
        const closed = await plane.close();
        if (closed instanceof Error) throw closed;
      }
    });
    const integrations = plane.integrations!;
    const read = async () =>
      await integrations.withUser("alice", (executor) =>
        executor.integrations.list(),
      );
    const [first, second] = await Promise.all([read(), read()]);
    if (first instanceof Error) throw first;
    expect(second).toEqual(first);
    expect(first.map((entry) => entry.slug)).toContain("google_gmail");
    expect(first.map((entry) => entry.slug)).not.toContain("google_meet");
    const policy = await integrations.withUser("alice", (executor) =>
      executor.policies.create({
        owner: Owner.make("user"),
        pattern: "google_gmail.*",
        action: "block",
      }),
    );
    if (policy instanceof Error) throw policy;
    const custom = await integrations.withUser("alice", (executor) =>
      executor.openapi.addSpec({
        slug: "private-api",
        name: "Alice's API",
        authenticationTemplate: [
          {
            type: "apiKey",
            slug: "token",
            headers: {
              Authorization: ["Bearer ", { type: "variable", name: "token" }],
            },
          },
        ],
        spec: {
          kind: "blob",
          value: JSON.stringify({
            openapi: "3.0.0",
            info: { title: "Private", version: "1" },
            servers: [{ url: integrationApi.origin }],
            paths: {
              "/items": {
                get: {
                  operationId: "listItems",
                  responses: { "200": { description: "OK" } },
                },
              },
            },
          }),
        },
      }),
    );
    if (custom instanceof Error) throw custom;
    const connection = await integrations.withUser("alice", (executor) =>
      executor.connections.create({
        owner: Owner.make("user"),
        name: ConnectionName.make("personal"),
        integration: IntegrationSlug.make("private-api"),
        template: AuthTemplateSlug.make("token"),
        value: "private-test-token",
      }),
    );
    if (connection instanceof Error) throw connection;
    expect(
      await integrations.withUser("bob", (executor) =>
        executor.policies.list(),
      ),
    ).toEqual([]);
    expect(
      await integrations.withUser("bob", (executor) =>
        executor.integrations.get(IntegrationSlug.make("private-api")),
      ),
    ).toBeNull();
    lifetime.open = false;
    const closed = await plane.close();
    expect(closed).toBeUndefined();
    expect(await read()).toBeInstanceOf(Error);

    const reopened = await ControlPlane.start({
      config,
      webRoot,
      workspaceProvider,
      integrationEncryptionKey,
      getOpenAPISpec: async () =>
        new Error("Persisted presets must not fetch again"),
    });
    if (reopened instanceof Error) throw reopened;
    cleanup.defer(async () => {
      const reopenedClosed = await reopened.close();
      if (reopenedClosed instanceof Error) throw reopenedClosed;
    });
    expect(
      await reopened.integrations!.withUser("alice", (executor) =>
        executor.policies.list(),
      ),
    ).toEqual([policy]);
    const persisted = await reopened.integrations!.withUser(
      "alice",
      (executor) =>
        executor.integrations.get(IntegrationSlug.make("private-api")),
    );
    expect(persisted).toMatchObject({
      slug: "private-api",
      name: "Alice's API",
    });
    const invoked = await reopened.integrations!.withUser("alice", (executor) =>
      executor.execute(
        ToolAddress.make(`${connection.address}.items.listItems`),
        {},
      ),
    );
    if (invoked instanceof Error) throw invoked;
    expect(JSON.stringify(invoked)).toContain("fixture-item");
    expect(
      integrationApi.requests.filter((request) => request.url === "/items"),
    ).toEqual([{ url: "/items", authorization: "Bearer private-test-token" }]);
  },
);

controlPlaneTest(
  "drains accepted integration work and rejects new work during shutdown",
  async ({ plane }) => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const work = plane.integrations!.withUser("alice", (executor) =>
      Effect.gen(function* () {
        entered.resolve();
        yield* Effect.promise(async () => await resume.promise);
        return yield* executor.policies.list();
      }),
    );
    await entered.promise;
    const closing = plane.integrations!.close();
    expect(
      await plane.integrations!.withUser("bob", (executor) =>
        executor.policies.list(),
      ),
    ).toBeInstanceOf(Error);
    resume.resolve();
    expect(await work).toEqual([]);
    expect(await closing).toBeUndefined();
  },
);

controlPlaneTest(
  "releases startup resources when the integration key is invalid",
  async ({ appDataDir, webRoot, workspaceProvider }) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1");
    await events.once(probe, "listening");
    // SAFETY: A listening TCP server has AddressInfo, not a pipe address.
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolveClose) =>
      probe.close(() => resolveClose()),
    );
    const config = {
      deployment: "local" as const,
      workspace: { deployment: "local" as const },
      appDataDir,
      port,
      auth: testAuth,
    };
    const failed = await ControlPlane.start({
      config,
      webRoot,
      workspaceProvider,
      integrationEncryptionKey: Buffer.alloc(1),
    });
    expect(failed).toBeInstanceOf(Error);
    const retried = await ControlPlane.start({
      config,
      webRoot,
      workspaceProvider,
      integrationEncryptionKey,
      getOpenAPISpec,
    });
    if (retried instanceof Error) throw retried;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const closed = await retried.close();
      if (closed instanceof Error) throw closed;
    });
    expect((await fetch(`${retried.origin}/health`)).status).toBe(200);
  },
);

controlPlaneTest(
  "stays reachable on loopback until closed",
  async ({ appDataDir, webRoot, workspaceProvider }) => {
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
      workspaceProvider,
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

async function readRuntimeSettings(appDataDir: string) {
  const runtime: unknown = JSON.parse(
    await fs.readFile(join(appDataDir, workspaceRuntimeConfigFileName), "utf8"),
  );
  if (!Value.Check(workspaceRuntimeConfigSchema, runtime))
    throw new Error("Invalid assigned workspace service settings");
  return runtime;
}

controlPlaneTest(
  "assigns a stable workspace-only key and rejects user or gateway credentials",
  async ({ plane, authenticatedRpc, browserHeaders, appDataDir }) => {
    const workspace = await authenticatedRpc.workspace.ensure();
    const runtime = await readRuntimeSettings(appDataDir);
    expect(runtime).toMatchObject({
      origin: plane.origin,
      workspaceId: workspace.id,
      generation: 1,
    });
    expect(Object.keys(workspace).toSorted()).toEqual(["createdAt", "id"]);
    const endpoint = `${plane.origin}/api/workspace-runtime/identity`;
    const accepted = await fetch(endpoint, {
      headers: { authorization: `Bearer ${runtime.token}` },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(await accepted.json()).toEqual({ workspaceId: workspace.id });
    await authenticatedRpc.workspace.ensure();
    expect(await readRuntimeSettings(appDataDir)).toEqual(runtime);
    const rejectedHeaders = [
      browserHeaders,
      new Headers(),
      new Headers({ authorization: "Bearer invalid" }),
      new Headers({ authorization: "Bearer test-workspace-token" }),
    ];
    for (const headers of rejectedHeaders) {
      const rejected = await fetch(endpoint, { headers });
      expect(rejected.status).toBe(401);
    }
    const machineClient = createControlPlaneRpcClient(
      plane.origin,
      runtime.token,
    );
    expect(await machineClient.auth.session()).toEqual({
      status: "signed-out",
    });
    await expect(machineClient.workspace.ensure()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      machineClient.workspace.rotateRuntimeToken(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    for (const action of ["create", "get", "list", "update", "delete"]) {
      const rejected = await fetch(
        `${plane.origin}/api/auth/api-key/${action}`,
        {
          method: action === "get" || action === "list" ? "GET" : "POST",
          headers: browserHeaders,
        },
      );
      expect(rejected.status).toBe(404);
    }
  },
);

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
  "shares one persistent credential across concurrent control-plane instances",
  async ({ plane, appDataDir, webRoot, workspaceProvider, browserHeaders }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const second = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir,
        port: 0,
        auth: testAuth,
      },
      workspaceProvider,
      webRoot,
    });
    if (second instanceof Error) throw second;
    cleanup.defer(async () => {
      const closed = await second.close();
      if (closed instanceof Error) console.warn(closed);
    });
    const firstRpc = createControlPlaneRpcClient(plane.origin, browserHeaders);
    const secondRpc = createControlPlaneRpcClient(
      second.origin,
      browserHeaders,
    );
    const results = await Promise.all([
      firstRpc.workspace.ensure(),
      secondRpc.workspace.ensure(),
      firstRpc.workspace.ensure(),
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    const before = await readRuntimeSettings(appDataDir);
    await secondRpc.workspace.ensure();
    const after = await readRuntimeSettings(appDataDir);
    expect(after.token).toBe(before.token);
    for (const origin of [plane.origin, second.origin]) {
      const response = await fetch(`${origin}/api/workspace-runtime/identity`, {
        headers: { authorization: `Bearer ${after.token}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ workspaceId: results[0]?.id });
    }
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

// This opt-in test calls the real billed Together service; there is no fake model host.
controlPlaneTest.skipIf(process.env.HALO_TEST_TOGETHER_API_KEY === undefined)(
  "streams a real Together completion using the assigned workspace key",
  async ({ plane, authenticatedRpc, appDataDir }) => {
    await authenticatedRpc.workspace.ensure();
    const runtime = await readRuntimeSettings(appDataDir);
    const response = await fetch(
      `${plane.origin}${workspaceInferencePath}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: togetherModel.id,
          stream: true,
          max_tokens: 32,
          reasoning: { enabled: false },
          messages: [{ role: "user", content: "Reply with exactly: halo" }],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = await response.text();
    expect(stream).toContain("data: [DONE]");
    const text = stream
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => {
        // SAFETY: Together's documented SSE chunks contain OpenAI-compatible deltas.
        const chunk = JSON.parse(line.slice(6)) as {
          choices: Array<{ delta: { content?: string } }>;
        };
        return chunk.choices
          .map((choice) => choice.delta.content ?? "")
          .join("");
      })
      .join("");
    expect(text.toLowerCase()).toContain("halo");
    const invalidMessage = await fetch(
      `${plane.origin}${workspaceInferencePath}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: togetherModel.id,
          stream: true,
          messages: [{ role: "invalid-role", content: "Invalid input" }],
        }),
      },
    );
    expect(invalidMessage.status).toBe(400);
    expect(await invalidMessage.text()).toContain("error");
  },
  60_000,
);

const providerControlPlaneTest = controlPlaneTest.extend<{
  workspaceProvider: WorkspaceProviderApi;
}>({
  workspaceProvider: async ({ workspaceHost }, use) => {
    await use(workspaceHost.provider);
  },
});

providerControlPlaneTest(
  "uses the supplied provider for authenticated gateway traffic before and after ensure",
  async ({ plane, browserHeaders }) => {
    const beforeEnsure = await fetch(`${plane.origin}/workspace/health`, {
      headers: browserHeaders,
    });
    expect(beforeEnsure.status).toBe(200);
    expect(await beforeEnsure.json()).toEqual({ workspace: "test-workspace" });

    const spoofed = new Headers(browserHeaders);
    spoofed.set("x-halo-public-host", "attacker.example");
    spoofed.set("x-halo-public-proto", "https");
    const forwarded = await fetch(`${plane.origin}/workspace/headers`, {
      headers: spoofed,
    });
    expect(forwarded.status).toBe(200);
    expect(await forwarded.json()).toMatchObject({
      "x-halo-public-host": new URL(plane.origin).host,
      "x-halo-public-proto": "http",
    });

    const rpc = createControlPlaneRpcClient(plane.origin, browserHeaders);
    const [first, concurrent] = await Promise.all([
      rpc.workspace.ensure(),
      rpc.workspace.ensure(),
    ]);
    expect(concurrent).toEqual(first);
    const afterEnsure = await fetch(`${plane.origin}/workspace/health`, {
      headers: browserHeaders,
    });
    expect(afterEnsure.status).toBe(200);
    expect(await afterEnsure.json()).toEqual({ workspace: "test-workspace" });
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

controlPlaneTest.skipIf(process.env.HALO_TEST_TRACE_BUCKET === undefined)(
  "isolates real trace uploads by workspace key and preserves immutable retries",
  async ({ plane, traceCloud, authenticatedRpc, appDataDir }) => {
    const alice = await authenticatedRpc.workspace.ensure();
    const aliceRuntime = await readRuntimeSettings(appDataDir);
    const bobHeaders = await createAuthenticatedHeaders(
      appDataDir,
      plane.origin,
      "trace-bob@example.com",
    );
    const bob = await createControlPlaneRpcClient(
      plane.origin,
      bobHeaders,
    ).workspace.ensure();
    const bobRuntime = await readRuntimeSettings(appDataDir);
    const traceId = "a".repeat(32);
    const endpoint = `${plane.origin}/api/traces/conversation/${traceId}`;
    const send = async (
      token: string,
      body: Buffer,
      suffix = "",
      extraHeaders = {},
    ) =>
      await fetch(endpoint + suffix, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/gzip",
          ...extraHeaders,
        },
        body,
      });
    const aliceArchive = traceArchive(alice.id, traceId);
    const bobArchive = traceArchive(bob.id, traceId);
    expect((await send(aliceRuntime.token, bobArchive)).status).toBe(400);
    expect(
      (await send(aliceRuntime.token, aliceArchive, `?workspaceId=${bob.id}`))
        .status,
    ).toBe(400);
    const aliceKey = `v1/workspaces/${alice.id}/sessions/conversation/${traceId}.jsonl.gz`;
    const bobKey = `v1/workspaces/${bob.id}/sessions/conversation/${traceId}.jsonl.gz`;
    traceCloud.track(aliceKey);
    traceCloud.track(bobKey);
    expect(
      (
        await send(aliceRuntime.token, aliceArchive, "", {
          "x-workspace-id": bob.id,
          "x-user-id": "bob",
        })
      ).status,
    ).toBe(204);
    expect((await send(bobRuntime.token, bobArchive)).status).toBe(204);
    expect(await traceCloud.read(aliceKey)).toEqual(aliceArchive);
    expect(await traceCloud.read(bobKey)).toEqual(bobArchive);
    expect(
      (
        await send(
          aliceRuntime.token,
          traceArchive(alice.id, traceId, "modified"),
        )
      ).status,
    ).toBe(204);
    expect(await traceCloud.read(aliceKey)).toEqual(aliceArchive);
    await authenticatedRpc.workspace.rotateRuntimeToken();
    expect((await send(aliceRuntime.token, aliceArchive)).status).toBe(401);
    const rotated = await readRuntimeSettings(appDataDir);
    expect((await send(rotated.token, aliceArchive)).status).toBe(204);
  },
  30_000,
);

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
