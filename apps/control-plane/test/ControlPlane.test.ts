import { gzipSync } from "node:zlib";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@sinclair/typebox";
import {
  AuthTemplateSlug,
  ConnectionName,
  Effect,
  IntegrationSlug,
  OAuthClientSlug,
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
import { expect, test, vi } from "vitest";
import { createHaloClient, sessionToolExecutions } from "@get-halo/client";
import { Logger } from "@get-halo/logger";
import { WorkspaceServer } from "@get-halo/workspace-server";
import { createOpenAILLMApi } from "@get-halo/workspace-server/llm";
import { LLMDriver } from "@get-halo/workspace-server/testing";
import { m } from "@get-halo/shared/testing";
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
const getOpenAPISpec = async (
  _url: string,
  origin = "https://example.invalid",
) =>
  JSON.stringify({
    discoveryVersion: "v1",
    id: "test:v1",
    name: "test",
    version: "v1",
    title: "Test Google API",
    rootUrl: `${origin}/`,
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
          create: {
            id: "test.documents.create",
            path: "documents",
            httpMethod: "POST",
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
  allowLocalIntegrationUrls: boolean;
  agent: {
    run: (code: string) => Promise<ReturnType<typeof sessionToolExecutions>>;
  };
  mcpApi: { publicEndpoint: string; privateEndpoint: string; calls: string[] };
  integrationApi: {
    origin: string;
    requests: { url: string | undefined; authorization: string | undefined }[];
    disconnected: string[];
  };
}>({
  allowLocalIntegrationUrls: true,
  agent: async ({ plane, authenticatedRpc, appDataDir }, use) => {
    await authenticatedRpc.workspace.ensure();
    const runtime = createControlPlaneRpcClient(
      plane.origin,
      (await readRuntimeSettings(appDataDir)).token,
    );
    await using cleanup = new errore.AsyncDisposableStack();
    const llm = await LLMDriver.start();
    if (llm instanceof Error) throw llm;
    cleanup.defer(async () => await llm.close());
    const workspaceRoot = join(appDataDir, "agent-workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
    const server = await WorkspaceServer.start({
      config: {
        environment: "local",
        workspaceRoot,
        appDataDir: join(appDataDir, "agent-data"),
        appVersion: "test",
        ownerUserId: "agent-fixture",
        host: "127.0.0.1",
        port: 0,
        corsOrigins: [],
        extensionRuntime: {
          executable: process.execPath,
          electronRunAsNode: false,
        },
      },
      host: {
        llmApi: createOpenAILLMApi(llm.configuration),
        logger: new Logger({ sinks: [] }),
        remoteIntegrationTools: {
          search: async (input, signal) =>
            await runtime.integrations.search(input, { signal }),
          describe: async (input, signal) =>
            await runtime.integrations.describe(input, { signal }),
          invoke: async (input, signal) =>
            await runtime.integrations.invoke(input, { signal }),
        },
      },
    });
    if (server instanceof Error) throw server;
    cleanup.defer(async () => {
      const closed = await server.close();
      if (closed instanceof Error) throw closed;
    });
    const connection = server.ready.connections.cli;
    const client = createHaloClient({
      transport: {
        origin: `http://127.0.0.1:${connection.port}`,
        path: "/rpc",
        headers: { authorization: `Bearer ${connection.token}` },
      },
    });
    await use({
      run: async (code) => {
        const session = await client.thread.new();
        const submitted = await client.thread.prompt({
          ...session,
          text: "Run the integration fixture",
        });
        const waiting = client.thread.wait({
          ...session,
          submissionId: submitted.submissionId,
        });
        await llm.respond(
          m.tool.start("exec", { id: "integration", arguments: { js: code } }),
        );
        await llm.respond(m.assistant("Done"));
        await waiting;
        return sessionToolExecutions(await client.thread.snapshot(session));
      },
    });
  },
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  mcpApi: async ({}, use) => {
    const calls: string[] = [];
    const inputSchema = Type.Object({ marker: Type.String() });
    const server = http.createServer(async (request, response) => {
      if (request.url !== "/public" && request.url !== "/private") {
        response.writeHead(404).end();
        return;
      }
      if (
        request.url === "/private" &&
        request.headers.authorization !== "Bearer fixture-mcp-key"
      ) {
        response.writeHead(401).end();
        return;
      }
      await using cleanup = new errore.AsyncDisposableStack();
      const mcp = new McpServer(
        { name: "fixture", version: "1" },
        { capabilities: { tools: {} } },
      );
      cleanup.defer(async () => await mcp.close());
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: "echo_marker", description: "Echo a marker", inputSchema },
          {
            name: "write_marker",
            description: "Write a marker",
            inputSchema,
            annotations: { destructiveHint: true },
          },
        ],
      }));
      mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        if (
          !["echo_marker", "write_marker"].includes(params.name) ||
          !Value.Check(inputSchema, params.arguments)
        )
          return {
            isError: true,
            content: [{ type: "text", text: "Invalid echo input" }],
          };
        calls.push(params.arguments.marker);
        return {
          content: [
            { type: "text", text: `MCP received: ${params.arguments.marker}` },
          ],
        };
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
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
    // SAFETY: A listening TCP server returns AddressInfo.
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    await use({
      publicEndpoint: `${origin}/public`,
      privateEndpoint: `${origin}/private`,
      calls,
    });
  },
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  integrationApi: async ({}, use) => {
    const requests: {
      url: string | undefined;
      authorization: string | undefined;
      apiKey: string | string[] | undefined;
    }[] = [];
    const disconnected: string[] = [];
    const server = http.createServer((request, response) => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        apiKey: request.headers["x-api-key"],
      });
      if (request.url === "/redirect-spec") {
        response
          .writeHead(302, {
            location: "http://169.254.169.254/computeMetadata/v1/",
          })
          .end();
        return;
      }
      if (request.url === "/setup-spec" || request.url === "/key-spec") {
        const origin = `http://${request.headers.host}`;
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            openapi: "3.0.0",
            info: { title: "Setup fixture", version: "1" },
            servers: [{ url: origin }],
            components: {
              securitySchemes:
                request.url === "/key-spec"
                  ? {
                      key: {
                        type: "apiKey",
                        in: "header",
                        name: "X-Api-Key",
                      },
                    }
                  : {
                      oauth: {
                        type: "oauth2",
                        flows: {
                          authorizationCode: {
                            authorizationUrl: `${origin}/oauth/authorize`,
                            tokenUrl: `${origin}/oauth/token`,
                            scopes: { read: "Read" },
                          },
                        },
                      },
                    },
            },
            security:
              request.url === "/key-spec"
                ? [{ key: [] }]
                : [{ oauth: ["read"] }],
            paths: {
              "/items": {
                get: {
                  operationId: "listItems",
                  responses: { "200": { description: "OK" } },
                },
              },
            },
          }),
        );
        return;
      }
      if (request.url === "/oauth/token") {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: "fixture-google-token",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "fixture-refresh-token",
          }),
        );
        return;
      }
      if (request.url === "/test/v1/documents") {
        if (request.headers.authorization !== "Bearer fixture-google-token") {
          response.writeHead(401).end();
          return;
        }
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ items: ["google-document"] }));
        return;
      }
      if (request.url === "/lost") {
        request.socket.destroy();
        return;
      }
      if (request.url === "/slow") {
        response.once("close", () => disconnected.push("/slow"));
        return;
      }
      if (request.url === "/error") {
        response
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "provider failed" }));
        return;
      }
      if (request.url?.startsWith("/mutations/")) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ written: request.url.split("/").at(-1) }));
        return;
      }
      if (request.url !== "/items") {
        response.writeHead(404).end();
        return;
      }
      if (
        request.headers["x-api-key"] === "rejected-api-key" ||
        request.headers["x-api-key"] === "forbidden-api-key"
      ) {
        response
          .writeHead(
            request.headers["x-api-key"] === "rejected-api-key" ? 401 : 403,
          )
          .end();
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
    await use({
      origin: `http://127.0.0.1:${address.port}`,
      requests,
      disconnected,
    });
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
    {
      appDataDir,
      webRoot,
      traceCloud,
      workspaceProvider,
      inferenceApiKey,
      integrationApi,
      allowLocalIntegrationUrls,
    },
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
      allowLocalIntegrationUrls,
      getOpenAPISpec: async (url) =>
        await getOpenAPISpec(url, integrationApi.origin),
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
  "creates human-only connections through durable setup RPC",
  async ({ plane, authenticatedRpc, browserHeaders, appDataDir, mcpApi }) => {
    const human = authenticatedRpc;
    await human.workspace.ensure();
    const runtime = createControlPlaneRpcClient(
      plane.origin,
      (await readRuntimeSettings(appDataDir)).token,
    );
    await human.integrations.registerMcp({
      name: "Public MCP",
      slug: "setup-public",
      endpoint: mcpApi.publicEndpoint,
      auth: "none",
    });
    await human.integrations.registerMcp({
      name: "Private MCP",
      slug: "setup-private",
      endpoint: mcpApi.privateEndpoint,
      auth: "bearer",
    });
    const catalog = await runtime.integrations.catalog();
    expect(
      catalog.find((entry) => entry.integration === "setup-private")?.methods,
    ).toEqual([
      {
        template: "bearer",
        label: expect.any(String),
        kind: "apikey",
        fields: ["token"],
      },
    ]);
    const bobHeaders = await createAuthenticatedHeaders(
      appDataDir,
      plane.origin,
      "setup-bob@example.com",
    );
    bobHeaders.set("origin", plane.origin);
    const bob = createControlPlaneRpcClient(plane.origin, bobHeaders);
    for (const integration of ["setup-public", "setup-private"]) {
      const started = await runtime.integrations.startSetup({
        integration,
        connectionName: "personal",
      });
      expect(started.setupUrl).toBe(
        `${plane.origin}/integrations/setup/${started.setupId}`,
      );
      expect(
        await human.integrations.setup({ setupId: started.setupId }),
      ).toMatchObject({
        status: "awaiting_credentials",
      });
      await expect(
        bob.integrations.setup({ setupId: started.setupId }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        bob.integrations.cancelSetup({ setupId: started.setupId }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        bob.integrations.submitSetup({
          setupId: started.setupId,
          template: "none",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        runtime.integrations.submitSetup({
          setupId: started.setupId,
          template: "none",
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(
        runtime.integrations.registerMcp({
          name: "Bad",
          slug: "bad",
          endpoint: mcpApi.publicEndpoint,
          auth: "none",
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      const method = catalog.find((entry) => entry.integration === integration)!
        .methods[0]!;
      const pendingDuplicate = await human.integrations.startSetup({
        integration,
        connectionName: "personal",
      });
      await human.integrations.submitSetup({
        setupId: started.setupId,
        template: method.template,
        values: method.kind === "none" ? {} : { token: "fixture-mcp-key" },
      });
      await expect(
        human.integrations.submitSetup({
          setupId: pendingDuplicate.setupId,
          template: method.template,
          values: method.kind === "none" ? {} : { token: "do-not-overwrite" },
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await human.integrations.cancelSetup({
        setupId: pendingDuplicate.setupId,
      });
      const ready = await runtime.integrations.setup({
        setupId: started.setupId,
      });
      expect(ready).toMatchObject({
        status: "ready",
        connection: { integration, name: "personal" },
      });
      expect(JSON.stringify(ready)).not.toContain("fixture-mcp-key");
      await expect(
        human.integrations.submitSetup({
          setupId: started.setupId,
          template: method.template,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const reconnect = await human.integrations.startSetup({
        integration,
        connectionName: "personal",
      });
      await expect(
        bob.integrations.submitSetup({
          setupId: reconnect.setupId,
          template: method.template,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await human.integrations.cancelSetup({ setupId: reconnect.setupId });
      expect(await human.integrations.connections()).toContainEqual(
        ready.connection,
      );
      const tools = await runtime.integrations.search({
        query: "echo",
        integration,
      });
      expect(
        await runtime.integrations.invoke({
          address: tools.tools[0]!.address,
          arguments: { marker: integration },
        }),
      ).toMatchObject({ status: "completed" });
    }
    const cancelled = await human.integrations.startSetup({
      integration: "setup-public",
    });
    await runtime.integrations.cancelSetup({ setupId: cancelled.setupId });
    await runtime.integrations.cancelSetup({ setupId: cancelled.setupId });
    expect(
      await human.integrations.setup({ setupId: cancelled.setupId }),
    ).toMatchObject({ status: "cancelled" });
    const crossOrigin = new Headers(browserHeaders);
    crossOrigin.set("origin", "https://untrusted.example");
    await expect(
      createControlPlaneRpcClient(
        plane.origin,
        crossOrigin,
      ).integrations.submitSetup({
        setupId: cancelled.setupId,
        template: "none",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const callback = await fetch(
      `${plane.origin}/api/integrations/oauth/callback?state=foreign&code=secret`,
      { redirect: "manual" },
    );
    expect(callback.status).toBe(400);
    expect(await callback.text()).not.toContain("secret");
  },
);

controlPlaneTest(
  "redeems OAuth setup state once and preserves setups across restart",
  async ({
    agent,
    plane,
    authenticatedRpc,
    browserHeaders,
    appDataDir,
    integrationApi,
    webRoot,
    workspaceProvider,
  }) => {
    await expect(
      authenticatedRpc.integrations.registerOpenAPI({
        name: "Redirect",
        slug: "redirect",
        url: `${integrationApi.origin}/redirect-spec`,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    await authenticatedRpc.integrations.registerOpenAPI({
      name: "Local OAuth",
      slug: "setup-oauth",
      url: `${integrationApi.origin}/setup-spec`,
    });
    await authenticatedRpc.integrations.registerOpenAPI({
      name: "Local key",
      slug: "setup-key",
      url: `${integrationApi.origin}/key-spec`,
    });
    const session = await authenticatedRpc.auth.session();
    if (session.status !== "signed-in") throw new Error("Missing session");
    const missingClient = await authenticatedRpc.integrations.startSetup({
      integration: "setup-oauth",
    });
    const oauthMethod = (await authenticatedRpc.integrations.catalog()).find(
      (entry) => entry.integration === "setup-oauth",
    )!.methods[0]!;
    await expect(
      authenticatedRpc.integrations.submitSetup({
        setupId: missingClient.setupId,
        template: oauthMethod.template,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("No configured OAuth client"),
    });
    expect(
      await authenticatedRpc.integrations.setup({
        setupId: missingClient.setupId,
      }),
    ).toMatchObject({ status: "failed" });
    const configured = await plane.integrations!.withUser(
      session.session.user.id,
      (executor) =>
        executor.oauth.createClient({
          owner: Owner.make("user"),
          slug: OAuthClientSlug.make("local"),
          authorizationUrl: `${integrationApi.origin}/oauth/authorize`,
          tokenUrl: `${integrationApi.origin}/oauth/token`,
          grant: "authorization_code",
          clientId: "fixture",
          clientSecret: "private-client-secret",
        }),
    );
    if (configured instanceof Error) throw configured;
    const googleConfigured = await plane.integrations!.withUser(
      session.session.user.id,
      (executor) =>
        executor.openapi.configure(IntegrationSlug.make("google_gmail"), {
          authenticationTemplate: [
            {
              slug: "googleOAuth2",
              kind: "oauth2",
              authorizationUrl: `${integrationApi.origin}/oauth/authorize`,
              tokenUrl: `${integrationApi.origin}/oauth/token`,
              scopes: ["read"],
            },
          ],
        }),
    );
    if (googleConfigured instanceof Error) throw googleConfigured;
    const google = await authenticatedRpc.integrations.startSetup({
      integration: "google_gmail",
    });
    const googleAuthorization = await authenticatedRpc.integrations.submitSetup(
      { setupId: google.setupId, template: "googleOAuth2" },
    );
    const googleState = new URL(
      googleAuthorization.authorizationUrl!,
    ).searchParams.get("state")!;
    expect(
      (
        await fetch(
          `${plane.origin}/api/integrations/oauth/callback?state=${encodeURIComponent(googleState)}&code=google-code`,
          { redirect: "manual" },
        )
      ).status,
    ).toBe(303);
    expect(
      await authenticatedRpc.integrations.setup({ setupId: google.setupId }),
    ).toMatchObject({
      status: "ready",
      connection: { integration: "google_gmail" },
    });
    const catalog = await authenticatedRpc.integrations.catalog();
    const keyMethod = catalog.find(
      (entry) => entry.integration === "setup-key",
    )!.methods[0]!;
    const key = await authenticatedRpc.integrations.startSetup({
      integration: "setup-key",
    });
    await authenticatedRpc.integrations.submitSetup({
      setupId: key.setupId,
      template: keyMethod.template,
      values: { token: "private-api-key" },
    });
    expect(
      await authenticatedRpc.integrations.setup({ setupId: key.setupId }),
    ).toMatchObject({ status: "ready" });
    const keyReady = await authenticatedRpc.integrations.setup({
      setupId: key.setupId,
    });
    await authenticatedRpc.workspace.ensure();
    const runtimeClient = createControlPlaneRpcClient(
      plane.origin,
      (await readRuntimeSettings(appDataDir)).token,
    );
    const keyTools = await runtimeClient.integrations.search({
      query: "listItems",
      integration: "setup-key",
    });
    const keyAddress = keyTools.tools[0]!.address;
    const keyReconnect = await authenticatedRpc.integrations.startSetup({
      integration: "setup-key",
      connectionName: keyReady.connectionName,
    });
    const invocationsBeforeReconnect = integrationApi.requests.filter(
      (request) => request.url === "/items",
    ).length;
    const replacements = await Promise.allSettled(
      [1, 2].map(
        async () =>
          await authenticatedRpc.integrations.submitSetup({
            setupId: keyReconnect.setupId,
            template: keyMethod.template,
            values: { token: "replacement-api-key" },
          }),
      ),
    );
    expect(
      replacements.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await authenticatedRpc.integrations.setup({
        setupId: keyReconnect.setupId,
      }),
    ).toMatchObject({ status: "ready", connection: keyReady.connection });
    expect(
      integrationApi.requests.filter((request) => request.url === "/items"),
    ).toHaveLength(invocationsBeforeReconnect);
    expect(
      await runtimeClient.integrations.invoke({
        address: keyAddress,
        arguments: {},
      }),
    ).toMatchObject({ status: "completed" });
    expect(integrationApi.requests.at(-1)).toMatchObject({
      apiKey: "replacement-api-key",
    });
    for (const token of ["rejected-api-key", "forbidden-api-key"]) {
      const retrySetup = await authenticatedRpc.integrations.startSetup({
        integration: "setup-key",
        connectionName: keyReady.connectionName,
      });
      await authenticatedRpc.integrations.submitSetup({
        setupId: retrySetup.setupId,
        template: keyMethod.template,
        values: { token },
      });
      expect(
        await runtimeClient.integrations.invoke({
          address: keyAddress,
          arguments: {},
        }),
      ).toMatchObject(
        token === "rejected-api-key"
          ? {
              status: "connection_required",
              integration: "setup-key",
              connectionName: keyReady.connectionName,
            }
          : { status: "failed", code: "tool_failed" },
      );
      const executed = await agent.run(
        `await tools[${JSON.stringify(`integrations.${keyAddress}`)}]({});`,
      );
      const details = executed[0]?.result?.details;
      if (token === "rejected-api-key") {
        expect(details).toMatchObject({
          connectionRequests: [
            {
              kind: "control-plane",
              integration: "setup-key",
              connectionName: keyReady.connectionName,
            },
          ],
        });
        expect(executed).toMatchObject([{ approvals: [] }]);
      } else {
        expect(details).not.toHaveProperty("connectionRequests");
      }
    }
    const repaired = await authenticatedRpc.integrations.startSetup({
      integration: "setup-key",
      connectionName: keyReady.connectionName,
    });
    const beforeRepair = integrationApi.requests.length;
    await authenticatedRpc.integrations.submitSetup({
      setupId: repaired.setupId,
      template: keyMethod.template,
      values: { token: "replacement-api-key" },
    });
    expect(integrationApi.requests).toHaveLength(beforeRepair);
    const retried = await agent.run(
      `return await tools[${JSON.stringify(`integrations.${keyAddress}`)}]({});`,
    );
    expect(retried).toMatchObject([{ result: { isError: false } }]);
    expect(JSON.stringify(retried[0]?.result)).toContain("fixture-item");
    const method = catalog.find((entry) => entry.integration === "setup-oauth")!
      .methods[0]!;
    const start = await authenticatedRpc.integrations.startSetup({
      integration: "setup-oauth",
    });
    const submitted = await authenticatedRpc.integrations.submitSetup({
      setupId: start.setupId,
      template: method.template,
    });
    const state = new URL(submitted.authorizationUrl!).searchParams.get(
      "state",
    )!;
    expect(submitted.authorizationUrl).not.toContain("private-client-secret");
    await plane.close();
    const reopened = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir,
        port: 0,
        auth: testAuth,
      },
      webRoot,
      workspaceProvider,
      integrationEncryptionKey,
      allowLocalIntegrationUrls: true,
      getOpenAPISpec,
    });
    if (reopened instanceof Error) throw reopened;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const closed = await reopened.close();
      if (closed instanceof Error) console.warn(closed);
    });
    const headers = new Headers(browserHeaders);
    headers.set("origin", reopened.origin);
    const human = createControlPlaneRpcClient(reopened.origin, headers);
    expect(
      await human.integrations.setup({ setupId: start.setupId }),
    ).toMatchObject({ status: "authorizing" });
    const callback = `${reopened.origin}/api/integrations/oauth/callback?state=${encodeURIComponent(state)}&code=fixture-code`;
    const responses = await Promise.all([
      fetch(callback, { redirect: "manual" }),
      fetch(callback, { redirect: "manual" }),
    ]);
    expect(
      responses.map((response) => response.status).toSorted((a, b) => a - b),
    ).toEqual([303, 400]);
    expect(
      responses
        .find((response) => response.status === 303)!
        .headers.get("location"),
    ).toBe(`${reopened.origin}/integrations/setup/${start.setupId}`);
    const ready = await human.integrations.setup({ setupId: start.setupId });
    expect(ready).toMatchObject({
      status: "ready",
      connection: { integration: "setup-oauth" },
    });
    expect(JSON.stringify(ready)).not.toContain("fixture-google-token");
    const oauthReconnect = await human.integrations.startSetup({
      integration: "setup-oauth",
      connectionName: ready.connectionName,
    });
    const reauthorization = await human.integrations.submitSetup({
      setupId: oauthReconnect.setupId,
      template: method.template,
    });
    const competingReconnect = await human.integrations.startSetup({
      integration: "setup-oauth",
      connectionName: ready.connectionName,
    });
    await expect(
      human.integrations.submitSetup({
        setupId: competingReconnect.setupId,
        template: method.template,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await human.integrations.cancelSetup({
      setupId: competingReconnect.setupId,
    });
    const originalAuthorization = new URL(submitted.authorizationUrl!);
    const nextAuthorization = new URL(reauthorization.authorizationUrl!);
    expect(nextAuthorization.searchParams.get("client_id")).toBe(
      originalAuthorization.searchParams.get("client_id"),
    );
    expect(await human.integrations.connections()).toContainEqual(
      ready.connection,
    );
    const reconnectCallback = `${reopened.origin}/api/integrations/oauth/callback?state=${encodeURIComponent(nextAuthorization.searchParams.get("state")!)}&code=fixture-code`;
    expect(
      (await fetch(reconnectCallback, { redirect: "manual" })).status,
    ).toBe(303);
    expect(
      (await fetch(reconnectCallback, { redirect: "manual" })).status,
    ).toBe(400);
    expect(
      await human.integrations.setup({ setupId: oauthReconnect.setupId }),
    ).toMatchObject({ status: "ready", connection: ready.connection });
    expect(
      await human.integrations.setup({ setupId: key.setupId }),
    ).toMatchObject({ status: "ready" });
    const cancelled = await human.integrations.startSetup({
      integration: "setup-oauth",
    });
    const authorization = await human.integrations.submitSetup({
      setupId: cancelled.setupId,
      template: method.template,
    });
    await human.integrations.cancelSetup({ setupId: cancelled.setupId });
    const cancelledState = new URL(
      authorization.authorizationUrl!,
    ).searchParams.get("state")!;
    expect(
      (
        await fetch(
          `${reopened.origin}/api/integrations/oauth/callback?state=${encodeURIComponent(cancelledState)}&code=fixture-code`,
          { redirect: "manual" },
        )
      ).status,
    ).toBe(400);
    const declined = await human.integrations.startSetup({
      integration: "setup-oauth",
    });
    const declinedAuthorization = await human.integrations.submitSetup({
      setupId: declined.setupId,
      template: method.template,
    });
    const declinedState = new URL(
      declinedAuthorization.authorizationUrl!,
    ).searchParams.get("state")!;
    expect(
      (
        await fetch(
          `${reopened.origin}/api/integrations/oauth/callback?state=${encodeURIComponent(declinedState)}&error=access_denied`,
          { redirect: "manual" },
        )
      ).status,
    ).toBe(303);
    expect(
      await human.integrations.setup({ setupId: declined.setupId }),
    ).toMatchObject({ status: "failed" });
    const expiring = await human.integrations.startSetup({
      integration: "setup-oauth",
      connectionName: ready.connectionName,
    });
    const expiringAuthorization = await human.integrations.submitSetup({
      setupId: expiring.setupId,
      template: method.template,
    });
    const pendingKey = await human.integrations.startSetup({
      integration: "setup-key",
    });
    const expiringState = new URL(
      expiringAuthorization.authorizationUrl!,
    ).searchParams.get("state")!;
    vi.useFakeTimers({ toFake: ["Date"] });
    cleanup.defer(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    // A fresh reconnect must reclaim an abandoned attempt without polling it first.
    const fresh = await human.integrations.startSetup({
      integration: "setup-oauth",
      connectionName: ready.connectionName,
    });
    expect(
      await human.integrations.submitSetup({
        setupId: fresh.setupId,
        template: method.template,
      }),
    ).toHaveProperty("authorizationUrl");
    await human.integrations.cancelSetup({ setupId: fresh.setupId });
    expect(
      await human.integrations.setup({ setupId: expiring.setupId }),
    ).toMatchObject({ status: "expired" });
    expect(
      await human.integrations.setup({ setupId: pendingKey.setupId }),
    ).toMatchObject({ status: "expired" });
    expect(
      (
        await fetch(
          `${reopened.origin}/api/integrations/oauth/callback?state=${encodeURIComponent(expiringState)}&code=fixture-code`,
          { redirect: "manual" },
        )
      ).status,
    ).toBe(400);
    await expect(
      human.integrations.submitSetup({
        setupId: pendingKey.setupId,
        template: keyMethod.template,
        values: { token: "never-save" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  },
);

controlPlaneTest.extend({ allowLocalIntegrationUrls: false })(
  "rejects private and unsafe registration URLs",
  async ({ authenticatedRpc, plane }) => {
    for (const url of [
      "https://127.0.0.1/spec",
      "https://10.0.0.1/spec",
      "https://169.254.169.254/computeMetadata/v1",
      "https://[::1]/spec",
      "https://[::ffff:127.0.0.1]/spec",
      "http://example.com/spec",
      "file:///etc/passwd",
      "https://user:secret@example.com/spec",
    ]) {
      await expect(
        authenticatedRpc.integrations.registerOpenAPI({
          name: "Unsafe",
          slug: "unsafe",
          url,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        authenticatedRpc.integrations.registerMcp({
          name: "Unsafe",
          slug: "unsafe",
          endpoint: url,
          auth: "none",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    const catalog = await authenticatedRpc.integrations.catalog();
    expect(
      catalog.find((entry) => entry.integration === "unsafe"),
    ).toBeUndefined();
    const google = await authenticatedRpc.integrations.startSetup({
      integration: "google_gmail",
    });
    const authorization = await authenticatedRpc.integrations.submitSetup({
      setupId: google.setupId,
      template: "googleOAuth2",
    });
    expect(new URL(authorization.authorizationUrl!).hostname).toBe(
      "accounts.google.com",
    );
    expect(
      new URL(authorization.authorizationUrl!).searchParams.get("client_id"),
    ).toBe(testAuth.googleClientId);
    expect(authorization.authorizationUrl).not.toContain(
      testAuth.googleClientSecret,
    );
    expect(
      new URL(authorization.authorizationUrl!).searchParams.get("redirect_uri"),
    ).toBe(`${plane.origin}/api/integrations/oauth/callback`);
    await authenticatedRpc.integrations.cancelSetup({
      setupId: google.setupId,
    });
  },
);

controlPlaneTest(
  "automatically approves MCP, OpenAPI and Google connections across restart",
  async ({
    agent,
    plane,
    authenticatedRpc,
    browserHeaders,
    appDataDir,
    mcpApi,
    integrationApi,
    webRoot,
    workspaceProvider,
  }) => {
    await authenticatedRpc.workspace.ensure();
    const client = createControlPlaneRpcClient(
      plane.origin,
      (await readRuntimeSettings(appDataDir)).token,
    );
    const session = await authenticatedRpc.auth.session();
    if (session.status !== "signed-in") throw new Error("Missing test session");
    const userId = session.session.user.id;
    const setup = await plane.integrations!.withUser(userId, (executor) =>
      Effect.gen(function* () {
        yield* executor.mcp.addServer({
          name: "MCP",
          slug: "approval_mcp",
          endpoint: mcpApi.publicEndpoint,
          auth: { kind: "none" },
        });
        yield* executor.openapi.addSpec({
          name: "OpenAPI",
          slug: "approval_api",
          spec: {
            kind: "blob",
            value: JSON.stringify({
              openapi: "3.0.0",
              info: { title: "Approval API", version: "1" },
              servers: [{ url: integrationApi.origin }],
              paths: {
                "/items": {
                  get: {
                    operationId: "listItems",
                    responses: { "200": { description: "OK" } },
                  },
                },
                "/mutations/approved": {
                  post: {
                    operationId: "writeItem",
                    responses: { "200": { description: "OK" } },
                  },
                },
              },
            }),
          },
        });
        for (const integration of ["approval_mcp", "approval_api"]) {
          for (const name of ["personal", "other"]) {
            yield* executor.connections.create({
              owner: Owner.make("user"),
              integration: IntegrationSlug.make(integration),
              name: ConnectionName.make(name),
              template: AuthTemplateSlug.make("none"),
              values: {},
            });
          }
        }
        const oauthClient = yield* executor.oauth.createClient({
          owner: Owner.make("user"),
          slug: OAuthClientSlug.make("google_fixture"),
          authorizationUrl: `${integrationApi.origin}/oauth/authorize`,
          tokenUrl: `${integrationApi.origin}/oauth/token`,
          grant: "authorization_code",
          clientId: "fixture",
          clientSecret: "fixture-secret",
        });
        for (const name of ["personal", "other"]) {
          const started = yield* executor.oauth.start({
            client: oauthClient,
            clientOwner: Owner.make("user"),
            owner: Owner.make("user"),
            name: ConnectionName.make(name),
            integration: IntegrationSlug.make("google_gmail"),
            template: AuthTemplateSlug.make("googleOAuth2"),
            redirectUri: `${plane.origin}/integrations/oauth/callback`,
          });
          if (started.status !== "redirect")
            throw new Error("Expected Google OAuth redirect");
          expect(
            new URL(started.authorizationUrl).searchParams.get(
              "code_challenge",
            ),
          ).toBeTruthy();
          yield* executor.oauth.complete({
            state: started.state,
            code: `fixture-code-${name}`,
          });
        }
      }),
    );
    if (setup instanceof Error) throw setup;
    const bobHeaders = await createAuthenticatedHeaders(
      appDataDir,
      plane.origin,
      "approval-bob@example.com",
    );
    bobHeaders.set("origin", plane.origin);
    const bob = createControlPlaneRpcClient(plane.origin, bobHeaders);
    const csrfHeaders = new Headers(browserHeaders);
    csrfHeaders.set("origin", "https://untrusted.example");
    const csrf = createControlPlaneRpcClient(plane.origin, csrfHeaders);
    expect(await bob.integrations.connections()).toEqual([]);
    await expect(client.integrations.connections()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(csrf.integrations.connections()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    for (const integration of [
      "approval_mcp",
      "approval_api",
      "google_gmail",
    ]) {
      const connection = (
        await authenticatedRpc.integrations.connections()
      ).find(
        (entry) =>
          entry.integration === integration && entry.name === "personal",
      )!;
      expect(connection).toBeDefined();
      const tools = (
        await client.integrations.search({ query: "", integration })
      ).tools.filter((tool) => tool.connection === "personal");
      const described = await Promise.all(
        tools.map(
          async (tool) =>
            await client.integrations.describe({ address: tool.address }),
        ),
      );
      const read = described.find((tool) => !tool.requiresApproval)!;
      const write = described.find((tool) => tool.requiresApproval)!;
      expect(read).toBeDefined();
      expect(write).toBeDefined();
      const args = integration === "approval_mcp" ? { marker: "allowed" } : {};
      const routed = await agent.run(`
        const found = await tools.search({ query: ${JSON.stringify(read.name)}, source: "control-plane" });
        if (!found.ok) throw new Error(JSON.stringify(found));
        const path = ${JSON.stringify(`integrations.${read.address}`)};
        if (!found.data.tools.some(tool => tool.path === path)) throw new Error("Tool not discovered");
        const schema = await tools.describe.tool({ path });
        if (!schema.ok) throw new Error(JSON.stringify(schema));
        const result = await tools[path](${JSON.stringify(args)});
        if (!result.ok) throw new Error(JSON.stringify(result));
        return { provider: ${JSON.stringify(integration)}, result: result.data };
      `);
      expect(routed).toMatchObject([{ result: { isError: false } }]);
      expect(JSON.stringify(routed[0]?.result)).toContain(
        integration === "approval_mcp"
          ? "MCP received: allowed"
          : integration === "google_gmail"
            ? "google-document"
            : "fixture-item",
      );
      const invokeWrite = async () =>
        await client.integrations.invoke({
          address: write.address,
          arguments: args,
        });
      const before = () =>
        integration === "approval_mcp"
          ? mcpApi.calls.length
          : integrationApi.requests.length;
      expect(
        (
          await client.integrations.invoke({
            address: read.address,
            arguments: args,
          })
        ).status,
        integration,
      ).toBe("completed");
      const noWriteCount = before();
      expect((await invokeWrite()).status).toBe("completed");
      expect((await invokeWrite()).status).toBe("completed");
      expect(before()).toBe(noWriteCount + 2);
      expect(
        await client.integrations.invoke({
          address: write.address.replace(".personal.", ".other."),
          arguments: args,
        }),
      ).toMatchObject({ status: "completed" });
      // The approval fallback does not override explicit native restrictions.
      const block = await plane.integrations!.withUser(userId, (executor) =>
        executor.policies.create({
          owner: Owner.make("user"),
          pattern: write.address.slice("tools.".length),
          action: "block",
        }),
      );
      if (block instanceof Error) throw block;
      expect(await invokeWrite()).toEqual({ status: "blocked" });
      const removed = await plane.integrations!.withUser(userId, (executor) =>
        executor.policies.remove({ owner: Owner.make("user"), id: block.id }),
      );
      if (removed instanceof Error) throw removed;
      expect(await invokeWrite()).toMatchObject({ status: "completed" });
      expect(
        (
          await client.integrations.invoke({
            address: read.address,
            arguments: args,
          })
        ).status,
      ).toBe("completed");
    }
    const policyCount = await plane.integrations!.withUser(userId, (executor) =>
      executor.policies.list(),
    );
    if (policyCount instanceof Error) throw policyCount;
    expect(policyCount).toHaveLength(1);
    const closed = await plane.integrations!.close();
    if (closed instanceof Error) throw closed;
    const reopened = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir,
        port: 0,
        auth: testAuth,
      },
      webRoot,
      workspaceProvider,
      integrationEncryptionKey,
      allowLocalIntegrationUrls: true,
      getOpenAPISpec: async () => new Error("Must use saved catalogs"),
    });
    if (reopened instanceof Error) throw reopened;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const result = await reopened.close();
      if (result instanceof Error) throw result;
    });
    const saved = await reopened.integrations!.connections(userId);
    if (saved instanceof Error) throw saved;
    expect(saved).toHaveLength(6);
    const savedPolicies = await reopened.integrations!.withUser(
      userId,
      (executor) => executor.policies.list(),
    );
    expect(savedPolicies).toEqual(policyCount);
    for (const connection of saved.filter(
      (entry) => entry.name === "personal",
    )) {
      const tools = await reopened.integrations!.search({
        userId,
        query: "",
        integration: connection.integration,
      });
      if (tools instanceof Error) throw tools;
      const schemas = await Promise.all(
        tools.tools
          .filter((tool) => tool.connection === "personal")
          .map(
            async (tool) =>
              await reopened.integrations!.describe({
                userId,
                address: tool.address,
              }),
          ),
      );
      const write = schemas.find(
        (schema) => !(schema instanceof Error) && schema.requiresApproval,
      );
      if (write === undefined || write instanceof Error)
        throw new Error("Missing persisted write tool");
      const args: Record<string, string> =
        connection.integration === "approval_mcp"
          ? { marker: "after-restart" }
          : {};
      expect(
        await reopened.integrations!.invoke({
          userId,
          address: write.address,
          arguments: args,
        }),
      ).toMatchObject({ status: "completed" });
    }
    expect(
      await reopened.integrations!.withUser(userId, (executor) =>
        executor.policies.list(),
      ),
    ).toEqual(policyCount);
  },
);

controlPlaneTest(
  "discovers and invokes remote MCP tools with account isolation and native approval",
  async ({ plane, authenticatedRpc, appDataDir, mcpApi }) => {
    await authenticatedRpc.workspace.ensure();
    const runtime = await readRuntimeSettings(appDataDir);
    const client = createControlPlaneRpcClient(plane.origin, runtime.token);
    const session = await authenticatedRpc.auth.session();
    if (session.status !== "signed-in") throw new Error("Missing test session");
    const userId = session.session.user.id;
    for (const authenticated of [false, true]) {
      const slug = authenticated ? "private-mcp" : "public-mcp";
      const setup = await plane.integrations!.withUser(userId, (executor) =>
        Effect.gen(function* () {
          yield* executor.mcp.addServer({
            name: slug,
            slug,
            endpoint: authenticated
              ? mcpApi.privateEndpoint
              : mcpApi.publicEndpoint,
            remoteTransport: "streamable-http",
            auth: authenticated
              ? {
                  kind: "header",
                  headerName: "Authorization",
                  prefix: "Bearer ",
                }
              : { kind: "none" },
          });
          return yield* executor.connections.create({
            owner: Owner.make("user"),
            name: ConnectionName.make("personal"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make(authenticated ? "header" : "none"),
            ...(authenticated ? { value: "fixture-mcp-key" } : { values: {} }),
          });
        }),
      );
      if (setup instanceof Error) throw setup;
      const found = await client.integrations.search({
        query: "echo_marker",
        integration: slug,
      });
      expect(found.tools).toHaveLength(1);
      const address = found.tools[0]!.address;
      expect(address).toBe(`tools.${slug}.user.personal.echo_marker`);
      expect(await client.integrations.describe({ address })).toMatchObject({
        inputSchema: {
          properties: { marker: { type: "string" } },
          required: ["marker"],
        },
      });
      expect(
        await client.integrations.invoke({
          address,
          arguments: { marker: slug },
        }),
      ).toEqual({
        status: "completed",
        result: { content: [{ type: "text", text: `MCP received: ${slug}` }] },
      });
      const policy = await plane.integrations!.withUser(userId, (executor) =>
        executor.policies.create({
          owner: Owner.make("user"),
          pattern: `${slug}.*`,
          action: "require_approval",
        }),
      );
      if (policy instanceof Error) throw policy;
      expect(
        await client.integrations.invoke({
          address,
          arguments: { marker: "not-approved" },
        }),
      ).toEqual({ status: "approval_required" });
    }
    expect(mcpApi.calls).toEqual(["public-mcp", "private-mcp"]);
    const bobHeaders = await createAuthenticatedHeaders(
      appDataDir,
      plane.origin,
      "mcp-bob@example.com",
    );
    await createControlPlaneRpcClient(
      plane.origin,
      bobHeaders,
    ).workspace.ensure();
    const bob = createControlPlaneRpcClient(
      plane.origin,
      (await readRuntimeSettings(appDataDir)).token,
    );
    expect(await bob.integrations.search({ query: "echo_marker" })).toEqual({
      tools: [],
      truncated: false,
    });
    await expect(
      bob.integrations.invoke({
        address: "tools.private-mcp.user.personal.echo_marker",
        arguments: { marker: "other-user" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const markerPath = join(appDataDir, "forbidden-mcp-process");
    const stdio = await plane.integrations!.withUser(userId, (executor) =>
      executor.mcp.addServer({
        name: "Forbidden process",
        slug: "stdio",
        transport: "stdio",
        command: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned')`,
        ],
      }),
    );
    if (stdio instanceof Error) throw stdio;
    // Executor can save stdio metadata, but must not start its process for discovery.
    expect(
      await client.integrations.search({ query: "", integration: "stdio" }),
    ).toEqual({ tools: [], truncated: false });
    expect(await fs.readdir(appDataDir)).not.toContain("forbidden-mcp-process");
    expect(mcpApi.calls).toEqual(["public-mcp", "private-mcp"]);
  },
);

controlPlaneTest(
  "discovers and invokes only the runtime owner's integration tools through RPC",
  async ({
    plane,
    authenticatedRpc,
    rpc,
    browserHeaders,
    appDataDir,
    integrationApi,
  }) => {
    await authenticatedRpc.workspace.ensure();
    const runtime = await readRuntimeSettings(appDataDir);
    const client = createControlPlaneRpcClient(plane.origin, runtime.token);
    const session = await authenticatedRpc.auth.session();
    if (session.status !== "signed-in") throw new Error("Missing test session");
    const userId = session.session.user.id;
    const setup = await plane.integrations!.withUser(userId, (executor) =>
      Effect.gen(function* () {
        yield* executor.openapi.addSpec({
          slug: "rpc-api",
          name: "RPC fixture",
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
              info: { title: "RPC fixture", version: "1" },
              servers: [{ url: integrationApi.origin }],
              paths: {
                "/mutations/{id}": {
                  post: {
                    operationId: "write",
                    description: "Write a mutation",
                    parameters: [
                      {
                        name: "id",
                        in: "path",
                        required: true,
                        schema: { type: "string" },
                      },
                    ],
                    responses: { "200": { description: "OK" } },
                  },
                },
                "/lost": {
                  post: {
                    operationId: "loseResponse",
                    responses: { "200": { description: "OK" } },
                  },
                },
                "/error": {
                  post: {
                    operationId: "fail",
                    responses: { "200": { description: "OK" } },
                  },
                },
                "/slow": {
                  post: {
                    operationId: "wait",
                    responses: { "200": { description: "OK" } },
                  },
                },
              },
            }),
          },
        });
        return yield* executor.connections.create({
          owner: Owner.make("user"),
          name: ConnectionName.make("personal"),
          integration: IntegrationSlug.make("rpc-api"),
          template: AuthTemplateSlug.make("token"),
          value: "rpc-test-token",
        });
      }),
    );
    if (setup instanceof Error) throw setup;
    const discovered = await client.integrations.search({ query: "MUTATION" });
    expect(discovered.tools).toHaveLength(1);
    const address = discovered.tools[0]!.address;
    expect(discovered).toMatchObject({
      truncated: false,
      tools: [
        {
          integration: "rpc-api",
          connection: "personal",
          description: "Write a mutation",
        },
      ],
    });
    const schema = await client.integrations.describe({ address });
    expect(schema).toMatchObject({
      address,
      inputTypeScript: expect.any(String),
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    });
    const limited = await client.integrations.search({
      query: "",
      integration: "rpc-api",
      limit: 1,
    });
    expect(limited.tools).toHaveLength(1);
    expect(limited.truncated).toBe(true);

    for (const unauthorized of [
      rpc,
      authenticatedRpc,
      createControlPlaneRpcClient(plane.origin, browserHeaders),
    ]) {
      await expect(
        unauthorized.integrations.search({ query: "" }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(
        unauthorized.integrations.describe({ address }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(
        unauthorized.integrations.invoke({
          address,
          arguments: { id: "unauthorized" },
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    await expect(
      client.integrations.search({ query: "", limit: 101 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A forged owner must be rejected, not accepted as extra routing metadata.
    const forged = { query: "", userId: "someone-else" };
    await expect(client.integrations.search(forged)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    for (const forbidden of [
      "executor.policies.create",
      "executor.openapi.addSpec",
    ]) {
      await expect(
        client.integrations.describe({ address: forbidden }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        client.integrations.invoke({ address: forbidden, arguments: {} }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    const bobHeaders = await createAuthenticatedHeaders(
      appDataDir,
      plane.origin,
      "integration-bob@example.com",
    );
    await createControlPlaneRpcClient(
      plane.origin,
      bobHeaders,
    ).workspace.ensure();
    const bobRuntime = await readRuntimeSettings(appDataDir);
    const bob = createControlPlaneRpcClient(plane.origin, bobRuntime.token);
    expect(
      await bob.integrations.search({ query: "", integration: "rpc-api" }),
    ).toEqual({ tools: [], truncated: false });
    await expect(bob.integrations.describe({ address })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      bob.integrations.invoke({ address, arguments: { id: "stolen" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      integrationApi.requests.filter((request) =>
        request.url?.startsWith("/mutations/"),
      ),
    ).toEqual([]);

    expect(
      await client.integrations.invoke({
        address,
        arguments: { id: "accepted-17" },
      }),
    ).toEqual({ status: "completed", result: { written: "accepted-17" } });
    const invalid = await client.integrations.invoke({
      address,
      arguments: { id: "invalid", unexpected: true },
    });
    expect(invalid.status).toBe("failed");
    const policy = await plane.integrations!.withUser(userId, (executor) =>
      executor.policies.create({
        owner: Owner.make("user"),
        pattern: address.slice("tools.".length),
        action: "block",
      }),
    );
    if (policy instanceof Error) throw policy;
    expect(
      await client.integrations.invoke({
        address,
        arguments: { id: "blocked" },
      }),
    ).toEqual({ status: "blocked" });
    expect(await client.integrations.search({ query: "MUTATION" })).toEqual({
      tools: [],
      truncated: false,
    });
    await expect(
      client.integrations.describe({ address }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const changed = await plane.integrations!.withUser(userId, (executor) =>
      executor.policies.update({
        id: policy.id,
        owner: Owner.make("user"),
        action: "require_approval",
      }),
    );
    if (changed instanceof Error) throw changed;
    expect(
      await client.integrations.invoke({
        address,
        arguments: { id: "unapproved" },
      }),
    ).toEqual({ status: "approval_required" });
    expect(
      integrationApi.requests.filter((request) =>
        request.url?.startsWith("/mutations/"),
      ),
    ).toEqual([
      { url: "/mutations/accepted-17", authorization: "Bearer rpc-test-token" },
    ]);

    const tools = await client.integrations.search({
      query: "",
      integration: "rpc-api",
    });
    const lost = tools.tools.find((tool) =>
      tool.name.includes("loseResponse"),
    )!;
    expect(
      await client.integrations.invoke({
        address: lost.address,
        arguments: {},
      }),
    ).toMatchObject({ status: "failed", code: "outcome_unknown" });
    expect(
      integrationApi.requests.filter((request) => request.url === "/lost"),
    ).toHaveLength(1);
    const failed = tools.tools.find((tool) => tool.name.endsWith("fail"))!;
    expect(
      await client.integrations.invoke({
        address: failed.address,
        arguments: {},
      }),
    ).toMatchObject({ status: "failed", code: "tool_failed" });
    const slow = tools.tools.find((tool) => tool.name.endsWith("wait"))!;
    const controller = new AbortController();
    const waiting = client.integrations.invoke(
      { address: slow.address, arguments: {} },
      { signal: controller.signal },
    );
    await expect
      .poll(
        () =>
          integrationApi.requests.filter((request) => request.url === "/slow")
            .length,
      )
      .toBe(1);
    // A valid slow call must outlive initialization's 30-second deadline.
    expect(
      await Promise.race([
        waiting,
        new Promise<string>((done) =>
          setTimeout(() => done("pending"), 31_000),
        ),
      ]),
    ).toBe("pending");
    const cancelled = expect(waiting).rejects.toThrow();
    controller.abort();
    await cancelled;
    await expect.poll(() => integrationApi.disconnected).toEqual(["/slow"]);
    await authenticatedRpc.workspace.rotateRuntimeToken();
    await expect(
      client.integrations.invoke({ address, arguments: { id: "rotated" } }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const rotated = await readRuntimeSettings(appDataDir);
    expect(
      (
        await createControlPlaneRpcClient(
          plane.origin,
          rotated.token,
        ).integrations.search({ query: "MUTATION" })
      ).tools,
    ).toHaveLength(1);
  },
  60_000,
);

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
      allowLocalIntegrationUrls: true,
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
    ).toMatchObject([{ owner: "org", pattern: "*", action: "approve" }]);
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
      allowLocalIntegrationUrls: true,
      getOpenAPISpec: async () =>
        new Error("Persisted presets must not fetch again"),
    });
    if (reopened instanceof Error) throw reopened;
    cleanup.defer(async () => {
      const reopenedClosed = await reopened.close();
      if (reopenedClosed instanceof Error) throw reopenedClosed;
    });
    expect(await reopened.integrations!.connections("alice")).toMatchObject([
      { address: connection.address },
    ]);
    expect(
      await reopened.integrations!.withUser("alice", (executor) =>
        executor.policies.list(),
      ),
    ).toEqual(
      expect.arrayContaining([
        policy,
        expect.objectContaining({
          owner: "org",
          pattern: "*",
          action: "approve",
        }),
      ]),
    );
    const persisted = await reopened.integrations!.withUser(
      "alice",
      (executor) =>
        executor.integrations.get(IntegrationSlug.make("private-api")),
    );
    expect(persisted).toMatchObject({
      slug: "private-api",
      name: "Alice's API",
    });
    const replica = await ControlPlane.start({
      config,
      webRoot,
      workspaceProvider,
      integrationEncryptionKey,
      allowLocalIntegrationUrls: true,
      getOpenAPISpec,
    });
    if (replica instanceof Error) throw replica;
    cleanup.defer(async () => {
      const result = await replica.close();
      if (result instanceof Error) throw result;
    });
    const reconnect = await reopened.integrations!.startSetup({
      userId: "alice",
      integration: "private-api",
      connectionName: "personal",
    });
    if (reconnect instanceof Error) throw reconnect;
    expect(
      await replica.integrations!.setup({
        userId: "bob",
        setupId: reconnect.setupId,
      }),
    ).toBeInstanceOf(Error);
    const submissions = await Promise.all(
      [reopened, replica].map(
        async (host) =>
          await host.integrations!.submitSetup({
            userId: "alice",
            setupId: reconnect.setupId,
            template: "token",
            values: { token: "replica-replacement-token" },
          }),
      ),
    );
    expect(
      submissions.filter((result) => result instanceof Error),
    ).toHaveLength(1);
    expect(
      await replica.integrations!.setup({
        userId: "alice",
        setupId: reconnect.setupId,
      }),
    ).toMatchObject({
      status: "ready",
      connection: { address: connection.address },
    });
    const invoked = await reopened.integrations!.withUser("alice", (executor) =>
      executor.execute(
        ToolAddress.make(`${connection.address}.items.listItems`),
        {},
      ),
    );
    if (databaseUrl !== undefined) {
      // Cloud configuration must retain its egress guard, even in a database test.
      expect(invoked).toBeInstanceOf(Error);
      expect(invoked).toMatchObject({
        cause: {
          cause: {
            cause: {
              reason: {
                cause: { detail: "Remote integrations require HTTPS" },
              },
            },
          },
        },
      });
      expect(integrationApi.requests).toEqual([]);
    } else {
      if (invoked instanceof Error) throw invoked;
      expect(JSON.stringify(invoked)).toContain("fixture-item");
      expect(
        integrationApi.requests.filter((request) => request.url === "/items"),
      ).toEqual([
        { url: "/items", authorization: "Bearer replica-replacement-token" },
      ]);
    }
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
    expect(await work).toMatchObject([
      { owner: "org", pattern: "*", action: "approve" },
    ]);
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
