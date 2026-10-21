import crypto from "node:crypto";

import { OAuth2Client } from "google-auth-library";

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

import { TraceCloudDriver } from "../test/TraceCloudDriver.js";

import { InferenceDriver } from "../test/InferenceDriver.js";

import fs from "node:fs/promises";

import http from "node:http";

import events from "node:events";

import type { AddressInfo } from "node:net";

import { join, resolve } from "node:path";

import { DatabaseSync } from "node:sqlite";

import { createORPCClient } from "@orpc/client";

import { RPCLink } from "@orpc/client/fetch";

import { RPCLink as SocketRPCLink } from "@orpc/client/websocket";

import { haloProtocolVersion, type HaloClient } from "@get-halo/client";

import { writeWorkspaceServerConnection } from "@get-halo/shared/WorkspaceServerConnection";

import {
  IntegrationRegistrationError,
  type ControlPlaneClient,
} from "@get-halo/shared/controlPlaneContract";

import { betterAuth } from "better-auth";

import { testUtils } from "better-auth/plugins";

import * as errore from "errore";

import { expect, onTestFinished, test, vi } from "vitest";

import {
  type AutomationDelivery,
  createHaloClient,
  sessionToolExecutions,
} from "@get-halo/client";

import { Logger } from "@get-halo/logger";

import {
  ControlPlaneAutomationClient,
  WorkspaceServer,
} from "@get-halo/workspace-server";

import { createOpenAILLMApi } from "@get-halo/workspace-server/llm";

import { LLMDriver } from "@get-halo/workspace-server/testing";

import { m } from "@get-halo/shared/testing";

import { ControlPlane } from "../src/server/ControlPlane.js";

import { LocalWorkspaceProvider } from "../src/workspace/provider/local/LocalWorkspaceProvider.js";

import { DatabaseService } from "../src/DatabaseService.js";

import { AppStore } from "../src/apps/AppStore.js";

import { AppCredentials } from "../src/apps/AppCredentials.js";

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
  readonly requests: string[] = [];
  readonly exeAuthorizations: Array<string | undefined> = [];
  readonly scheduledProtocols: string[] = [];
  readonly eventProtocols: string[] = [];
  private readonly server: http.Server;

  private constructor(ctx: { appDataDir: string }) {
    this.provider = new LocalWorkspaceProvider(ctx);
    this.server = http.createServer((request, response) => {
      this.requests.push(request.url ?? "");
      const exeAuthorization = request.headers["x-exedev-authorization"];
      this.exeAuthorizations.push(
        Array.isArray(exeAuthorization)
          ? exeAuthorization[0]
          : exeAuthorization,
      );
      if (request.headers.authorization !== "Bearer test-workspace-token") {
        response.writeHead(401).end();
        return;
      }
      if (request.url === "/rpc/automations/runScheduled") {
        const protocol = request.headers["x-halo-protocol-version"];
        // Model a released protocol 25 workspace during a rolling deployment.
        if (protocol !== "25") {
          response.writeHead(400).end();
          return;
        }
        this.scheduledProtocols.push(protocol);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end('{"json":null}');
        return;
      }
      if (request.url === "/rpc/automations/acceptEvent") {
        const protocol = request.headers["x-halo-protocol-version"];
        if (protocol !== "25") {
          response.writeHead(400).end();
          return;
        }
        this.eventProtocols.push(protocol);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end('{"json":{"id":"released-workspace-run"}}');
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

  get origin() {
    // SAFETY: This getter is used only after the numeric TCP listener starts.
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
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


const testGithub = {
  clientId: "fixture-github-client-id",
  clientSecret: "fixture-github-client-secret",
};


const desktopAuthState = "desktop-auth-state-0123456789abcdef";


const integrationEncryptionKey = Buffer.alloc(32, 17);

// Only the external specification HTTP boundary is replaced. Executor parses,
// installs and persists the document through its real OpenAPI plugin.
const getOpenAPISpec = async (
  url: string,
  origin = "https://example.invalid",
) => {
  if (url.includes("github/rest-api-description"))
    return JSON.stringify({
      openapi: "3.0.3",
      info: { title: "GitHub", version: "1" },
      servers: [{ url: origin }],
      paths: {
        "/items": {
          get: {
            operationId: "repos/list-for-authenticated-user",
            summary: "List repositories for the authenticated user",
            responses: {
              "200": {
                description: "Repositories",
                content: {
                  "application/json": { schema: { type: "object" } },
                },
              },
            },
          },
        },
      },
    });
  return JSON.stringify({
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
};


type OAuthTokenDriver = {
  refreshError?: string;
  refreshes: number;
  githubRequests: URLSearchParams[];
};


const controlPlaneTest = test.extend<{
  traceCloud: TraceCloudDriver;
  inferenceApi: InferenceDriver;
  appDataDir: string;
  authenticatedRpc: ControlPlaneClient;
  browserHeaders: Headers;
  plane: ControlPlane;
  rpc: ControlPlaneClient;
  webRoot: string;
  marketingAdminUserIds: string[];
  marketingHostname: string | undefined;
  marketingHomepageOrigin: string | undefined;
  googleAnalyticsMeasurementId: string | undefined;
  environment: "production" | "staging" | "development" | undefined;
  workspaceProvider: WorkspaceProviderApi;
  workspaceHost: WorkspaceHostDriver;
  allowLocalIntegrationUrls: boolean;
  githubConfigured: boolean;
  githubSpecUnavailable: boolean;
  localGithubOAuth: boolean;
  agent: {
    rpc: ReturnType<typeof createHaloClient>;
    workspaceRoot: string;
    run: (code: string) => Promise<ReturnType<typeof sessionToolExecutions>>;
  };
  mcpApi: {
    publicEndpoint: string;
    privateEndpoint: string;
    calls: string[];
    requests: {
      endpoint: string | undefined;
      authorization: string | undefined;
    }[];
  };
  integrationApi: {
    origin: string;
    oauth: OAuthTokenDriver;
    requests: { url: string | undefined; authorization: string | undefined }[];
    disconnected: string[];
    revoked: string[];
    // Status 0 drops the connection instead of answering.
    revokeResponse: { status: number; body: string };
    gmail: {
      enabled: boolean;
      cursor: number;
      expired: boolean;
      rejected: boolean;
      watches: number;
      stops: number;
      messages: {
        id: string;
        historyId: number;
        from: string;
        subject: string;
        labels: string[];
      }[];
      token: (email?: string, audience?: string) => string;
    };
  };
}>({
  allowLocalIntegrationUrls: true,
  githubConfigured: true,
  githubSpecUnavailable: false,
  localGithubOAuth: false,
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
        remoteApps: runtime.apps,
        automationControl: new ControlPlaneAutomationClient({
          origin: plane.origin,
          token: (await readRuntimeSettings(appDataDir)).token,
        }),
        remoteIntegrationTools: {
          registerMcp: async (input, signal) =>
            await runtime.integrations
              .registerMcp(input, { signal })
              .catch((cause) => new IntegrationRegistrationError({ cause })),
          registerOpenAPI: async (input, signal) =>
            await runtime.integrations
              .registerOpenAPI(input, { signal })
              .catch((cause) => new IntegrationRegistrationError({ cause })),
          search: async (input, signal) =>
            await runtime.integrations.search(input, { signal }),
          describe: async (input, signal) =>
            await runtime.integrations.describe(input, { signal }),
          invoke: async (input, signal) =>
            await runtime.integrations.invoke(input, { signal }),
        },
        remoteConnections: {
          catalog: async () => await runtime.integrations.catalog(),
          startSetup: async (input) =>
            await runtime.integrations.startSetup(input),
          setup: async (input) => await runtime.integrations.setup(input),
          cancelSetup: async (input) =>
            await runtime.integrations.cancelSetup(input).then(() => undefined),
          connections: async () => await runtime.integrations.connections(),
          removeConnection: async (input) =>
            await runtime.integrations.removeConnection(input),
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
    const published = await writeWorkspaceServerConnection({
      appDataDir,
      connection: {
        workspaceRoot,
        origin: `http://127.0.0.1:${connection.port}`,
        token: connection.token,
      },
    });
    if (published instanceof Error) throw published;
    await use({
      rpc: client,
      workspaceRoot,
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
    const requests: {
      endpoint: string | undefined;
      authorization: string | undefined;
    }[] = [];
    const inputSchema = Type.Object({ marker: Type.String() });
    const server = http.createServer(async (request, response) => {
      requests.push({
        endpoint: request.url,
        authorization: request.headers.authorization,
      });
      if (request.url === "/events" || request.url === "/oversized-event") {
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        // SAFETY: Only Executor's MCP client sends JSON-RPC requests to this fixture.
        const message = JSON.parse(Buffer.concat(chunks).toString()) as {
          id?: number;
          method: string;
        };
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "large-events", version: "1" },
              }
            : {
                tools: [
                  { name: "echo_marker", description: "Echo", inputSchema },
                ],
              };
        // More than 64 MiB total is valid when each event stays below the cap.
        const padding =
          message.method !== "initialize"
            ? ""
            : request.url === "/events"
              ? `:${"x".repeat(40 * 1024 * 1024)}\r\n\r\n:${"x".repeat(40 * 1024 * 1024)}\n\n`
              : `:${"x".repeat(64 * 1024 * 1024)}\n\n`;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "content-encoding": "gzip",
        });
        response.end(
          gzipSync(
            `${padding}event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
          ),
        );
        return;
      }
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
      requests,
    });
  },
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  integrationApi: async ({}, use) => {
    const signing = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fixtureMessages: {
      id: string;
      historyId: number;
      from: string;
      subject: string;
      labels: string[];
    }[] = [];
    const gmail = {
      enabled: false,
      cursor: 100,
      expired: false,
      rejected: false,
      watches: 0,
      stops: 0,
      messages: fixtureMessages,
      token: (
        email = "push@halo.test",
        audience = "https://halo.test/api/automation-events/gmail",
      ) => {
        const header = Buffer.from(
          JSON.stringify({ alg: "RS256", kid: "fixture" }),
        ).toString("base64url");
        const payload = Buffer.from(
          JSON.stringify({
            iss: "https://accounts.google.com",
            aud: audience,
            sub: "push-service",
            email,
            email_verified: true,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        ).toString("base64url");
        const text = `${header}.${payload}`;
        return `${text}.${crypto.sign("RSA-SHA256", Buffer.from(text), signing.privateKey).toString("base64url")}`;
      },
    };
    const requests: {
      url: string | undefined;
      authorization: string | undefined;
      apiKey: string | string[] | undefined;
    }[] = [];
    const disconnected: string[] = [];
    const revoked: string[] = [];
    const revokeResponse = { status: 200, body: "" };
    const oauth: OAuthTokenDriver = {
      refreshes: 0,
      githubRequests: [],
    };
    const server = http.createServer((request, response) => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        apiKey: request.headers["x-api-key"],
      });
      if (request.url === "/google-certs") {
        response
          .writeHead(200, {
            "content-type": "application/json",
            "cache-control": "public, max-age=3600",
          })
          .end(
            JSON.stringify({
              fixture: signing.publicKey.export({
                type: "spki",
                format: "pem",
              }),
            }),
          );
        return;
      }
      if (request.url?.startsWith("/gmail/v1/")) {
        if (gmail.rejected) {
          response.writeHead(401).end();
          return;
        }
        const url = new URL(request.url, "http://fixture");
        const json = (body: string) =>
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(body);
        if (url.pathname.endsWith("/profile")) {
          json(
            JSON.stringify({
              emailAddress: "mailbox@example.net",
              historyId: String(gmail.cursor),
            }),
          );
          return;
        }
        if (url.pathname.endsWith("/watch")) {
          gmail.watches++;
          json(
            JSON.stringify({
              historyId: String(gmail.cursor),
              expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
            }),
          );
          return;
        }
        if (url.pathname.endsWith("/stop")) {
          gmail.stops++;
          json("{}");
          return;
        }
        if (url.pathname.endsWith("/history")) {
          if (gmail.expired) {
            response.writeHead(404).end();
            return;
          }
          const after = Number(url.searchParams.get("startHistoryId"));
          const offset = Number(url.searchParams.get("pageToken") ?? 0);
          const messages = gmail.messages.filter(
            (message) => message.historyId > after,
          );
          const page = messages.slice(offset, offset + 1);
          json(
            JSON.stringify({
              historyId: String(gmail.cursor),
              nextPageToken:
                offset + 1 < messages.length ? String(offset + 1) : undefined,
              history: page.map((message) => ({
                id: String(message.historyId),
                messagesAdded: [
                  { message: { id: message.id, labelIds: message.labels } },
                ],
              })),
            }),
          );
          return;
        }
        const message = gmail.messages.find((entry) =>
          url.pathname.endsWith(`/messages/${entry.id}`),
        );
        if (message === undefined) {
          response.writeHead(404).end();
          return;
        }
        json(
          JSON.stringify({
            id: message.id,
            threadId: `thread-${message.id}`,
            labelIds: message.labels,
            snippet: "Fixture email",
            payload: {
              headers: [
                { name: "From", value: message.from },
                { name: "Subject", value: message.subject },
              ],
            },
          }),
        );
        return;
      }
      if (request.url?.startsWith("/sized-spec")) {
        const prefix =
          '{"openapi":"3.0.0","info":{"title":"Bounded","version":"1"},"paths":{},"x-padding":"';
        const suffix = '"}';
        const bytes = 64 * 1024 * 1024 + (request.url.endsWith("over") ? 1 : 0);
        const eventType = request.url.includes("event");
        const body = eventType
          ? `${"\n".repeat(bytes - prefix.length - suffix.length)}${prefix}${suffix}`
          : `${prefix}${"x".repeat(bytes - prefix.length - suffix.length)}${suffix}`;
        response.writeHead(200, {
          "content-type": eventType ? "text/event-stream" : "application/json",
          "content-encoding": "gzip",
        });
        response.end(gzipSync(body));
        return;
      }
      if (request.url === "/redirect-spec") {
        response
          .writeHead(302, {
            location: "http://169.254.169.254/computeMetadata/v1/",
          })
          .end();
        return;
      }
      if (request.url === "/invalid-spec") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end("not an OpenAPI document");
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
      if (request.url === "/google-revoke") {
        let body = "";
        request.on("data", (chunk) => (body += String(chunk)));
        request.on("end", () => {
          revoked.push(new URLSearchParams(body).get("token") ?? "");
          if (revokeResponse.status === 0) request.socket.destroy();
          else
            response.writeHead(revokeResponse.status).end(revokeResponse.body);
        });
        return;
      }
      if (request.url === "/login/oauth/access_token") {
        let body = "";
        request.on("data", (chunk) => (body += String(chunk)));
        request.on("end", () => {
          const params = new URLSearchParams(body);
          oauth.githubRequests.push(params);
          const refresh = params.get("grant_type") === "refresh_token";
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              access_token: refresh
                ? "fixture-github-refreshed-token"
                : "fixture-github-token",
              token_type: "bearer",
              scope: "",
              expires_in: refresh ? 3600 : 0,
              refresh_token: "fixture-github-refresh-token",
              refresh_token_expires_in: 15897600,
            }),
          );
        });
        return;
      }
      if (request.url === "/oauth/token") {
        let body = "";
        request.on("data", (chunk) => (body += String(chunk)));
        request.on("end", () => {
          if (new URLSearchParams(body).get("grant_type") === "refresh_token") {
            oauth.refreshes++;
            if (oauth.refreshError !== undefined) {
              response
                .writeHead(400, { "content-type": "application/json" })
                .end(
                  JSON.stringify({
                    error: oauth.refreshError,
                    error_description: "private provider response",
                  }),
                );
              return;
            }
          }
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              access_token: "fixture-google-token",
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: "fixture-refresh-token",
            }),
          );
        });
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
      oauth,
      requests,
      disconnected,
      revoked,
      revokeResponse,
      gmail,
    });
  },
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  inferenceApi: async ({}, use) => {
    const driver = new InferenceDriver();
    await driver.start();
    await use(driver);
    await driver.close();
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
  marketingAdminUserIds: [],
  marketingHostname: undefined,
  marketingHomepageOrigin: undefined,
  googleAnalyticsMeasurementId: undefined,
  environment: undefined,
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
      inferenceApi,
      integrationApi,
      allowLocalIntegrationUrls,
      githubConfigured,
      githubSpecUnavailable,
      localGithubOAuth,
      marketingAdminUserIds,
      marketingHostname,
      marketingHomepageOrigin,
      googleAnalyticsMeasurementId,
      environment,
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
        marketingAdminUserIds,
        marketingHostname,
        marketingHomepageOrigin,
        googleAnalyticsMeasurementId,
        environment,
        auth: testAuth,
        github: githubConfigured ? testGithub : undefined,
        gmail: {
          topic: "projects/halo-test/topics/gmail",
          audience: "https://halo.test/api/automation-events/gmail",
          serviceAccount: "push@halo.test",
        },
      },
      webRoot,
      workspaceProvider,
      traceCloud: traceCloud.cloud(),
      inference: inferenceApi.configuration(),
      integrationEncryptionKey,
      allowLocalIntegrationUrls,
      githubOAuthOrigin: localGithubOAuth ? integrationApi.origin : undefined,
      gmailApiOrigin: integrationApi.origin,
      googleRevokeUrl: `${integrationApi.origin}/google-revoke`,
      gmailPushAuth: new OAuth2Client({
        endpoints: {
          oauth2FederatedSignonPemCertsUrl: `${integrationApi.origin}/google-certs`,
        },
      }),
      getOpenAPISpec: async (url) => {
        if (
          githubSpecUnavailable &&
          url.includes("github/rest-api-description")
        )
          return new Error("GitHub specification unavailable");
        return integrationApi.gmail.enabled && url.includes("gmail")
          ? gmailDiscovery(integrationApi.origin)
          : await getOpenAPISpec(url, integrationApi.origin);
      },
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
  "configures Halo's GitHub app without exposing its client secret",
  async ({ authenticatedRpc, plane, integrationApi }) => {
    const session = await authenticatedRpc.auth.session();
    if (session.status !== "signed-in") throw new Error("Missing test session");
    const clients = await plane.integrations!.withUser(
      session.session.user.id,
      (executor) => executor.oauth.listClients(),
    );
    if (clients instanceof Error) throw clients;
    expect(clients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: "first-party:github",
          authorizationUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          clientId: testGithub.clientId,
        }),
      ]),
    );
    expect(JSON.stringify(clients)).not.toContain(testGithub.clientSecret);
    await authenticatedRpc.integrations.registerOpenAPI({
      slug: "github-oauth-test",
      name: "GitHub OAuth test",
      url: `${integrationApi.origin}/key-spec`,
    });
    const configured = await plane.integrations!.withUser(
      session.session.user.id,
      (executor) =>
        executor.openapi.configure(IntegrationSlug.make("github-oauth-test"), {
          mode: "replace",
          authenticationTemplate: [
            {
              slug: "githubOAuth2",
              kind: "oauth2",
              authorizationUrl: "https://github.com/login/oauth/authorize",
              tokenUrl: "https://github.com/login/oauth/access_token",
              scopes: [],
            },
          ],
        }),
    );
    if (configured instanceof Error) throw configured;
    const setup = await authenticatedRpc.integrations.startSetup({
      integration: "github-oauth-test",
    });
    const submitted = await authenticatedRpc.integrations.submitSetup({
      setupId: setup.setupId,
      template: "githubOAuth2",
    });
    const authorization = new URL(submitted.authorizationUrl!);
    expect(authorization.origin).toBe("https://github.com");
    expect(authorization.searchParams.get("client_id")).toBe(
      testGithub.clientId,
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorization.searchParams.has("scope")).toBe(false);
    expect(submitted.authorizationUrl).not.toContain(testGithub.clientSecret);
    await authenticatedRpc.integrations.cancelSetup({ setupId: setup.setupId });
  },
);


controlPlaneTest.extend({ githubConfigured: false })(
  "omits the GitHub app when the deployment has no GitHub credentials",
  async ({ authenticatedRpc, plane }) => {
    const session = await authenticatedRpc.auth.session();
    if (session.status !== "signed-in") throw new Error("Missing test session");
    const clients = await plane.integrations!.withUser(
      session.session.user.id,
      (executor) => executor.oauth.listClients(),
    );
    if (clients instanceof Error) throw clients;
    expect(clients.map((client) => client.slug)).toContain(
      "first-party:google",
    );
    expect(clients.map((client) => client.slug)).not.toContain(
      "first-party:github",
    );
    expect(
      (await authenticatedRpc.integrations.catalog()).map(
        (entry) => entry.integration,
      ),
    ).not.toContain("github");
  },
);


// Durable: an optional provider failure must not prevent existing connections from being set up.
controlPlaneTest.extend({ githubSpecUnavailable: true })(
  "keeps Google setup usable when the GitHub specification is unavailable",
  async ({ authenticatedRpc }) => {
    const catalog = await authenticatedRpc.integrations.catalog();
    expect(catalog.some((entry) => entry.integration === "google_gmail")).toBe(
      true,
    );
    expect(catalog.some((entry) => entry.integration === "github")).toBe(false);
    const setup = await authenticatedRpc.integrations.startSetup({
      integration: "google_gmail",
    });
    expect(
      await authenticatedRpc.integrations.setup({ setupId: setup.setupId }),
    ).toMatchObject({ status: "awaiting_credentials" });
    await authenticatedRpc.integrations.cancelSetup({ setupId: setup.setupId });
  },
);


// Durable: the shipped preset must match the host-owned OAuth client's endpoints.
controlPlaneTest(
  "starts GitHub authorization with the shipped preset and Halo's app client",
  async ({ authenticatedRpc }) => {
    const setup = await authenticatedRpc.integrations.startSetup({
      integration: "github",
    });
    const submitted = await authenticatedRpc.integrations.submitSetup({
      setupId: setup.setupId,
      template: "githubOAuth2",
    });
    const authorization = new URL(submitted.authorizationUrl!);
    expect(authorization.origin).toBe("https://github.com");
    expect(authorization.pathname).toBe("/login/oauth/authorize");
    expect(authorization.searchParams.get("client_id")).toBe(
      testGithub.clientId,
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.has("scope")).toBe(false);
    await authenticatedRpc.integrations.cancelSetup({ setupId: setup.setupId });
  },
);


controlPlaneTest.extend({ localGithubOAuth: true })(
  "authorizes GitHub with PKCE and refreshes its user token before invoking REST tools",
  async ({
    authenticatedRpc,
    plane,
    appDataDir,
    integrationApi,
    browserHeaders,
  }) => {
    const session = await authenticatedRpc.auth.session();
    if (session.status !== "signed-in") throw new Error("Missing test session");
    // Only GitHub's external OAuth host changes; the same host-owned client
    // identity, Executor exchange/refresh, and Halo callback remain in use.
    const configured = await plane.integrations!.withUser(
      session.session.user.id,
      (executor) =>
        executor.openapi.configure(IntegrationSlug.make("github"), {
          mode: "replace",
          authenticationTemplate: [
            {
              slug: "githubOAuth2",
              kind: "oauth2",
              authorizationUrl: `${integrationApi.origin}/login/oauth/authorize`,
              tokenUrl: `${integrationApi.origin}/login/oauth/access_token`,
              scopes: [],
            },
          ],
        }),
    );
    if (configured instanceof Error) throw configured;
    const catalog = await authenticatedRpc.integrations.catalog();
    expect(
      catalog.find((entry) => entry.integration === "github"),
    ).toMatchObject({
      integration: "github",
      name: "GitHub",
      methods: [{ template: "githubOAuth2", kind: "oauth", fields: [] }],
    });
    const started = await authenticatedRpc.integrations.startSetup({
      integration: "github",
    });
    const submitted = await authenticatedRpc.integrations.submitSetup({
      setupId: started.setupId,
      template: "githubOAuth2",
    });
    const authorization = new URL(submitted.authorizationUrl!);
    expect(authorization.origin).toBe(integrationApi.origin);
    expect(authorization.searchParams.get("client_id")).toBe(
      testGithub.clientId,
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorization.searchParams.has("scope")).toBe(false);
    expect(submitted.authorizationUrl).not.toContain(testGithub.clientSecret);
    const callback = new URL("/api/integrations/oauth/callback", plane.origin);
    callback.searchParams.set(
      "state",
      authorization.searchParams.get("state")!,
    );
    callback.searchParams.set("code", "fixture-github-code");
    expect(
      (await fetch(callback, { headers: browserHeaders, redirect: "manual" }))
        .status,
    ).toBe(303);
    const ready = await authenticatedRpc.integrations.setup({
      setupId: started.setupId,
    });
    expect(ready).toMatchObject({
      status: "ready",
      connection: { integration: "github" },
    });
    expect(
      integrationApi.oauth.githubRequests[0]!.get("code_verifier"),
    ).toBeTruthy();
    expect(integrationApi.oauth.githubRequests[0]!.get("client_secret")).toBe(
      testGithub.clientSecret,
    );
    await authenticatedRpc.workspace.ensure();
    const runtime = createControlPlaneRpcClient(
      plane.origin,
      (await readRuntimeSettings(appDataDir)).token,
    );
    const discovered = await runtime.integrations.search({
      integration: "github",
      query: "repositories",
    });
    expect(discovered.tools).toHaveLength(1);
    expect(
      await runtime.integrations.invoke({
        address: discovered.tools[0]!.address,
        arguments: {},
      }),
    ).toMatchObject({ status: "completed" });
    expect(integrationApi.oauth.githubRequests[1]!.get("grant_type")).toBe(
      "refresh_token",
    );
    expect(integrationApi.oauth.githubRequests[1]!.get("refresh_token")).toBe(
      "fixture-github-refresh-token",
    );
    expect(integrationApi.requests.at(-1)).toMatchObject({
      url: "/items",
      authorization: "Bearer fixture-github-refreshed-token",
    });
    for (const secret of [
      testGithub.clientSecret,
      "fixture-github-token",
      "fixture-github-refresh-token",
      "fixture-github-refreshed-token",
    ])
      expect(JSON.stringify({ ready, discovered })).not.toContain(secret);
    await authenticatedRpc.integrations.removeConnection({
      integration: "github",
      name: ready.connectionName,
    });
    expect(
      await runtime.integrations.search({ integration: "github", query: "" }),
    ).toMatchObject({ tools: [] });
  },
);


const sleepingAutomationTest = controlPlaneTest.extend<{
  sleepingProvider: {
    paused: boolean;
    clockReady: boolean;
    failClockOnResume: boolean;
    resumeAttempts: number;
    clockSyncAttempts: number;
  };
  workspaceProvider: WorkspaceProviderApi;
}>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixture callbacks require destructured parameters.
  sleepingProvider: async ({}, use) => {
    await use({
      paused: true,
      clockReady: false,
      failClockOnResume: false,
      resumeAttempts: 0,
      clockSyncAttempts: 0,
    });
  },
  workspaceProvider: async ({ appDataDir, sleepingProvider }, use) => {
    const local = new LocalWorkspaceProvider({ appDataDir });
    await use({
      ensure: async (input) => await local.ensure(input),
      getConnection: async () => {
        if (sleepingProvider.paused || !sleepingProvider.clockReady)
          return undefined;
        const connection = await local.getConnection();
        if (connection instanceof Error || connection === undefined)
          return connection;
        return {
          origin: connection.origin,
          authorization: {
            type: "headers" as const,
            value: {
              authorization: "Bearer test-workspace-token",
              "x-exedev-authorization": "test-private-token",
            },
          },
        };
      },
      getStatus: async () =>
        sleepingProvider.paused ? ("paused" as const) : ("running" as const),
      resume: async () => {
        sleepingProvider.resumeAttempts += 1;
        sleepingProvider.paused = false;
        if (sleepingProvider.failClockOnResume) {
          sleepingProvider.failClockOnResume = false;
          return new Error("guest clock synchronization failed");
        }
        sleepingProvider.clockReady = true;
      },
      synchronizeClock: async () => {
        sleepingProvider.clockSyncAttempts += 1;
        sleepingProvider.clockReady = true;
      },
    } satisfies WorkspaceProviderApi);
  },
});


sleepingAutomationTest(
  "wakes a sleeping workspace and dispatches its due automation",
  async ({
    plane,
    authenticatedRpc,
    appDataDir,
    workspaceHost,
    sleepingProvider,
  }) => {
    const workspace = await authenticatedRpc.workspace.ensure();
    const runtime = await readRuntimeSettings(appDataDir);
    const published = await writeWorkspaceServerConnection({
      appDataDir,
      connection: {
        workspaceRoot: appDataDir,
        origin: workspaceHost.origin,
        token: "test-workspace-token",
      },
    });
    if (published instanceof Error) throw published;
    const endpoint = `${plane.origin}/api/workspace-runtime/automations/schedules`;
    const due = {
      automations: [
        {
          id: "morning-report",
          nextRunAt: new Date(Date.now() - 1000).toISOString(),
        },
      ],
    };
    const unauthorized = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify(due),
      headers: { authorization: "Bearer invalid" },
    });
    expect(unauthorized.status).toBe(401);
    const oldRoute = await fetch(
      `${plane.origin}/api/workspace-runtime/routines`,
      {
        method: "POST",
        body: JSON.stringify({ routines: due.automations }),
        headers: { authorization: `Bearer ${runtime.token}` },
      },
    );
    expect(oldRoute.status).toBe(404);
    const oldPayload = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ routines: due.automations }),
      headers: { authorization: `Bearer ${runtime.token}` },
    });
    expect(oldPayload.status).toBe(400);
    for (const body of ["{", "x".repeat(256 * 1024 + 1)]) {
      const malformed = await fetch(endpoint, {
        method: "POST",
        body,
        headers: { authorization: `Bearer ${runtime.token}` },
      });
      expect(malformed.status).toBe(400);
    }

    const invalid = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({
        automations: [{ id: "bad", nextRunAt: "not a date" }],
      }),
      headers: { authorization: `Bearer ${runtime.token}` },
    });
    expect(invalid.status).toBe(400);
    const accepted = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify(due),
      headers: { authorization: `Bearer ${runtime.token}` },
    });
    expect(accepted.status).toBe(204);
    await vi.waitFor(() => {
      expect(sleepingProvider.paused).toBe(false);
      expect(workspaceHost.requests).toContain("/rpc/automations/runScheduled");
      expect(workspaceHost.scheduledProtocols).toContain("25");
      expect(workspaceHost.exeAuthorizations).toContain("test-private-token");
    });
    expect(workspace.id).toBe(runtime.workspaceId);
  },
);


sleepingAutomationTest(
  "repairs the guest clock after resume unpauses the VM but clock sync fails",
  async ({
    plane,
    authenticatedRpc,
    appDataDir,
    workspaceHost,
    sleepingProvider,
  }) => {
    await authenticatedRpc.workspace.ensure();
    const runtime = await readRuntimeSettings(appDataDir);
    const published = await writeWorkspaceServerConnection({
      appDataDir,
      connection: {
        workspaceRoot: appDataDir,
        origin: workspaceHost.origin,
        token: "test-workspace-token",
      },
    });
    if (published instanceof Error) throw published;
    sleepingProvider.failClockOnResume = true;
    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const endpoint = `${plane.origin}/api/workspace-runtime/automations/schedules`;
    const snapshot = {
      automations: [
        { id: "morning-report", nextRunAt: new Date(now - 1000).toISOString() },
      ],
    };
    const publish = async () =>
      await fetch(endpoint, {
        method: "POST",
        body: JSON.stringify(snapshot),
        headers: { authorization: `Bearer ${runtime.token}` },
      });
    try {
      expect((await publish()).status).toBe(204);
      await vi.waitFor(() => expect(errorLog).toHaveBeenCalled());
      expect(sleepingProvider.paused).toBe(false);
      expect(sleepingProvider.clockReady).toBe(false);
      expect(workspaceHost.requests).not.toContain(
        "/rpc/automations/runScheduled",
      );

      dateNow.mockReturnValue(now + 31_000);
      expect((await publish()).status).toBe(204);
      await vi.waitFor(() => {
        expect(sleepingProvider.clockSyncAttempts).toBe(1);
        expect(workspaceHost.requests).toContain(
          "/rpc/automations/runScheduled",
        );
      });
      expect(sleepingProvider.resumeAttempts).toBe(1);
    } finally {
      dateNow.mockRestore();
      errorLog.mockRestore();
    }
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


const inferenceReply = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;


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
  userId?: string,
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
    id: userId ?? crypto.randomUUID(),
    email,
    name: "Desktop User",
  });
  await context.test.saveUser(user);
  const login = await context.test.login({ userId: user.id });
  return login.headers;
}


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


function gmailDiscovery(origin: string) {
  const parameter = {
    userId: { type: "string", location: "path", required: true },
  };
  return JSON.stringify({
    discoveryVersion: "v1",
    id: "gmail:v1",
    name: "gmail",
    version: "v1",
    title: "Gmail fixture",
    rootUrl: `${origin}/`,
    servicePath: "",
    schemas: {
      WatchRequest: {
        type: "object",
        properties: {
          topicName: { type: "string" },
          labelIds: { type: "array", items: { type: "string" } },
          labelFilterBehavior: { type: "string" },
        },
      },
    },
    resources: {
      users: {
        methods: {
          getProfile: {
            id: "gmail.users.getProfile",
            path: "gmail/v1/users/{userId}/profile",
            httpMethod: "GET",
            parameters: parameter,
            response: { type: "object" },
          },
          watch: {
            id: "gmail.users.watch",
            path: "gmail/v1/users/{userId}/watch",
            httpMethod: "POST",
            parameters: parameter,
            request: { $ref: "WatchRequest" },
            response: { type: "object" },
          },
          stop: {
            id: "gmail.users.stop",
            path: "gmail/v1/users/{userId}/stop",
            httpMethod: "POST",
            parameters: parameter,
            response: { type: "object" },
          },
        },
        resources: {
          history: {
            methods: {
              list: {
                id: "gmail.users.history.list",
                path: "gmail/v1/users/{userId}/history",
                httpMethod: "GET",
                parameters: {
                  ...parameter,
                  startHistoryId: {
                    type: "string",
                    location: "query",
                    required: true,
                  },
                  pageToken: { type: "string", location: "query" },
                  maxResults: { type: "integer", location: "query" },
                  historyTypes: {
                    type: "string",
                    repeated: true,
                    location: "query",
                  },
                },
                response: { type: "object" },
              },
            },
          },
          messages: {
            methods: {
              get: {
                id: "gmail.users.messages.get",
                path: "gmail/v1/users/{userId}/messages/{id}",
                httpMethod: "GET",
                parameters: {
                  ...parameter,
                  id: { type: "string", location: "path", required: true },
                  format: { type: "string", location: "query" },
                  metadataHeaders: {
                    type: "string",
                    repeated: true,
                    location: "query",
                  },
                },
                response: { type: "object" },
              },
            },
          },
        },
      },
    },
  });
}


const publicAppTest = controlPlaneTest.extend<{
  workspaceProvider: WorkspaceProviderApi;
  publicApps: {
    store: AppStore;
    appId: string;
    request: (input: {
      path: string;
      method?: string;
      headers?: Record<string, string>;
    }) => Promise<{
      status: number;
      body: string;
      headers: http.IncomingHttpHeaders;
    }>;
  };
}>({
  workspaceProvider: async ({ workspaceHost }, use) =>
    await use(workspaceHost.provider),
  publicApps: async ({ plane, appDataDir }, use) => {
    const db = await DatabaseService.start({
      type: "sqlite",
      path: join(appDataDir, "control-plane.db"),
    });
    if (db instanceof Error) throw db;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const closed = await db.close();
      if (closed instanceof Error) throw closed;
    });
    const store = new AppStore({ db });
    const handle = await store.ensureHandle({
      userId: "public-app-owner",
      email: "creator@example.com",
    });
    if (handle instanceof Error) throw handle;
    const records: { appId: string }[] = [];
    for (const syncAccess of ["read-only", "shared", "actions"] as const) {
      const app = await store.create({
        ownerUserId: "public-app-owner",
        extensionId: syncAccess,
        slug: syncAccess,
        displayName: '<Reading & "list">',
        visibility: "public",
        members: [],
        syncAccess,
        actions: [],
      });
      if (app instanceof Error) throw app;
      const live = await store.advance({
        appId: app.appId,
        from: "frozen",
        to: "live",
      });
      if (live instanceof Error) throw live;
      records.push(live);
    }
    const port = Number(new URL(plane.origin).port);
    const host = `${handle}.localhost:${port}`;
    await use({
      store,
      appId: records[0]!.appId,
      request: async (input) =>
        await new Promise((complete, reject) => {
          const request = http.request(
            {
              host: "127.0.0.1",
              port,
              path: input.path,
              method: input.method ?? "GET",
              headers: { host, ...input.headers },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.on("end", () =>
                complete({
                  status: response.statusCode!,
                  body: Buffer.concat(chunks).toString(),
                  headers: response.headers,
                }),
              );
            },
          );
          request.on("error", reject);
          request.end();
        }),
    });
  },
});


// Durable: every public sync mode gets gateway chrome, with no changes to the app's assets or API.
publicAppTest(
  "public extension waitlist banner wraps every sync mode and preserves content routes",
  async ({ publicApps, workspaceHost }) => {
    for (const mode of ["read-only", "shared", "actions"]) {
      const response = await publicApps.request({
        path: `/${mode}/view/details?filter=one%26two`,
      });
      expect(response.status).toBe(200);
      expect(response.body).toContain("Halo is in private alpha.");
      expect(response.body).toContain("/halo-donut-transparent.png");
      expect(response.body).toContain(
        'title="&lt;Reading &amp; &quot;list&quot;&gt;"',
      );
      expect(response.body).toContain(
        `src="/${mode}/view/details?filter=one%26two"`,
      );
      expect(response.headers["content-security-policy"]).toContain(
        "form-action https://buttondown.com https://gethalo.dev",
      );
      const inner = await publicApps.request({
        path: `/${mode}/view/details?filter=one%26two`,
        headers: {
          "sec-fetch-dest": "iframe",
          "sec-fetch-site": "same-origin",
        },
      });
      expect(inner.status).toBe(200);
      expect(inner.body).not.toContain("Halo is in private alpha.");
      const navigation = await publicApps.request({
        path: `/${mode}/view/next`,
        headers: {
          "sec-fetch-dest": "iframe",
          "sec-fetch-site": "same-origin",
        },
      });
      expect(navigation.status).toBe(200);
      expect(navigation.body).not.toContain("Halo is in private alpha.");
      const embedded = await publicApps.request({
        path: `/${mode}/view/`,
        headers: { "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" },
      });
      expect(embedded.body).toContain("Halo is in private alpha.");
      expect(workspaceHost.requests).toContain(
        `/extensions/${mode}/view/details?filter=one%26two`,
      );
      expect(
        (await publicApps.request({ path: `/${mode}/view/assets/view.js` }))
          .body,
      ).not.toContain("Halo is in private alpha.");
      expect(
        (await publicApps.request({ path: `/${mode}/api/items` })).body,
      ).not.toContain("Halo is in private alpha.");
    }
    const head = await publicApps.request({
      path: "/read-only/view/",
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    const root = await publicApps.request({ path: "/read-only/" });
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe("/read-only/view/");
  },
);


// Durable: sharing visibility still controls whether a visitor can open a banner or app.
publicAppTest(
  "public extension waitlist banner follows the app's sharing visibility",
  async ({ publicApps }) => {
    const privateApp = await publicApps.store.updateAccess({
      appId: publicApps.appId,
      access: { visibility: "invited", members: ["member@example.com"] },
    });
    if (privateApp instanceof Error) throw privateApp;
    const invited = await publicApps.request({ path: "/read-only/view/" });
    expect(invited.status).toBe(302);
    expect(invited.body).not.toContain("Halo is in private alpha.");
    const hidden = await publicApps.store.updateAccess({
      appId: publicApps.appId,
      published: false,
    });
    if (hidden instanceof Error) throw hidden;
    const unpublished = await publicApps.request({ path: "/read-only/view/" });
    expect(unpublished.status).toBe(404);
    expect(unpublished.body).not.toContain("Halo is in private alpha.");
  },
);


type AppVmRemovalDriver = {
  failure: Error | undefined;
  snapshotFailure: boolean;
  available: boolean;
  snapshots: number;
  removed: Set<string>;
  appIds: Set<string>;
  origin: string;
};


const appRemovalTest = controlPlaneTest.extend<{
  removalSupported: boolean;
  appWorkspaceCollision: boolean;
  publicationComplete: boolean;
  templateDemo: boolean;
  templateCopy: boolean;
  workspaceProvider: WorkspaceProviderApi;
  vmRemoval: AppVmRemovalDriver;
  appRemoval: {
    appId: string;
    backup: string;
    reference: string;
    runtimeToken: string;
  };
}>({
  removalSupported: true,
  appWorkspaceCollision: false,
  publicationComplete: true,
  templateDemo: false,
  templateCopy: false,
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native Vitest fixture signature.
  vmRemoval: async ({}, use) => {
    const state: AppVmRemovalDriver = {
      failure: undefined,
      snapshotFailure: false,
      available: true,
      snapshots: 0,
      removed: new Set<string>(),
      appIds: new Set<string>(),
      origin: "",
    };
    // The external app-VM RPC boundary supplies its latest frozen artifact.
    const server = http.createServer((request, response) => {
      if (request.url !== "/rpc/extensions/snapshotForRemoval") {
        response.writeHead(404).end();
        return;
      }
      state.snapshots += 1;
      response.setHeader("content-type", "application/json");
      if (state.snapshotFailure) {
        response.writeHead(400).end(
          JSON.stringify({
            json: {
              defined: false,
              inferable: true,
              code: "BAD_REQUEST",
              message: "Hosted snapshot is unavailable",
            },
          }),
        );
        return;
      }
      const buildId = "39ac4a1e-df81-492f-8f77-80a39e001cc6";
      const launcher = `import http from "node:http"; const server = http.createServer((_req, res) => res.end("latest hosted extension")); server.listen(0, "127.0.0.1", () => process.send("http://127.0.0.1:" + server.address().port + "/view/")); process.on("message", (message) => { if (message === "shutdown") server.close(() => process.exit(0)); });`;
      response.end(
        JSON.stringify({
          json: {
            files: {
              "package.json": JSON.stringify({
                name: "delete-me",
                halo: { displayName: "Delete me" },
              }),
              "latest.txt": "newest source from the VM",
            },
            assets: {},
            build: {
              "dist/start.mjs": Buffer.from(launcher).toString("base64"),
              "dist/current.json": Buffer.from(
                JSON.stringify(buildId),
              ).toString("base64"),
              [`dist/${buildId}/server.mjs`]:
                Buffer.from(launcher).toString("base64"),
            },
            data: "latest hosted data",
          },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await events.once(server, "listening");
    // SAFETY: The fixture has started a numeric TCP listener before reading its address.
    const address = server.address() as AddressInfo;
    state.origin = `http://127.0.0.1:${address.port}`;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      server.closeAllConnections();
      await new Promise<void>((complete, reject) =>
        server.close((error) =>
          error === undefined ? complete() : reject(error),
        ),
      );
    });
    await use(state);
  },
  workspaceProvider: async (
    { appDataDir, vmRemoval, removalSupported, templateCopy },
    use,
  ) => {
    const local = new LocalWorkspaceProvider({ appDataDir });
    await use({
      hostsSharedApps: true,
      ensure: async (input) => await local.ensure(input),
      getConnection: async (input) => {
        // Ready template copies only contact their owner's workspace to add a reference.
        if (templateCopy) return await local.getConnection();
        if (vmRemoval.removed.has(input.workspaceId)) return undefined;
        if (vmRemoval.appIds.has(input.workspaceId) && !vmRemoval.available)
          return undefined;
        if (vmRemoval.appIds.has(input.workspaceId))
          return {
            origin: vmRemoval.origin,
            authorization: { type: "bearer", value: "Bearer test-app-vm" },
          };
        return await local.getConnection();
      },
      removeAppVm: removalSupported
        ? async ({ appId }) => {
            if (vmRemoval.failure !== undefined) return vmRemoval.failure;
            vmRemoval.removed.add(appId);
          }
        : undefined,
    });
  },
  appRemoval: async (
    {
      plane,
      authenticatedRpc,
      appDataDir,
      agent,
      publicationComplete,
      templateDemo,
      templateCopy,
      appWorkspaceCollision,
      vmRemoval,
    },
    use,
  ) => {
    const session = await authenticatedRpc.auth.session();
    if (session.status !== "signed-in")
      throw new Error("Owner must be signed in");
    await authenticatedRpc.apps.publisher();
    const db = await DatabaseService.start({
      type: "sqlite",
      path: join(appDataDir, "control-plane.db"),
    });
    if (db instanceof Error) throw db;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const closed = await db.close();
      if (closed instanceof Error) throw closed;
    });
    const store = new AppStore({ db });
    const templateId = crypto.randomUUID();
    // Resume a completed publication; no actual cloud VM is used by these tests.
    const app = await store.create({
      origin:
        templateDemo || templateCopy
          ? { kind: templateDemo ? "demo" : "template", templateId }
          : undefined,
      ownerUserId: session.session.user.id,
      extensionId: "delete-me",
      slug: "delete-me",
      displayName: "Delete me",
      visibility: "public",
      members: [],
      syncAccess: "read-only",
      actions: [],
    });
    if (app instanceof Error) throw app;
    if (appWorkspaceCollision) {
      const workspace = await authenticatedRpc.workspace.ensure();
      if (!(db.appClient instanceof DatabaseSync))
        throw new Error("Collision fixture needs SQLite");
      // Inject inconsistent persisted state: an app points at a main workspace.
      // Normal publication generates a fresh app ID, so this needs fault injection.
      db.appClient
        .prepare("UPDATE apps SET app_id = ? WHERE app_id = ?")
        .run(workspace.id, app.appId);
      db.appClient
        .prepare("UPDATE app_origins SET app_id = ? WHERE app_id = ?")
        .run(workspace.id, app.appId);
      app.appId = workspace.id;
    }
    vmRemoval.appIds.add(app.appId);
    const advanced = await store.advance({
      appId: app.appId,
      from: "frozen",
      to: templateCopy ? "ready" : publicationComplete ? "live" : "frozen",
    });
    if (advanced instanceof Error) throw advanced;
    if (templateCopy || !publicationComplete) {
      const source = join(agent.workspaceRoot, ".halo/extensions/delete-me");
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(
        join(source, "package.json"),
        JSON.stringify({ name: "delete-me" }),
      );
      await fs.writeFile(join(source, "private.txt"), "keep my local source");
      if (!templateCopy)
        await agent.rpc.extensions.freeze({
          id: app.extensionId,
          appId: app.appId,
        });
    } else {
      await agent.rpc.extensions.addRemote({
        id: app.extensionId,
        appId: app.appId,
        displayName: app.displayName,
        url: `${plane.origin}/delete-me/view/`,
      });
    }
    if (templateCopy) {
      const template = await store.createTemplate({
        templateId,
        ownerUserId: session.session.user.id,
        sourceAppId: crypto.randomUUID(),
        slug: "delete-me",
        displayName: "Delete me",
        description: "A template awaiting its workspace reference",
        artifact: JSON.stringify({
          files: {},
          assets: {},
          build: {},
          data: "",
        }),
        demoAppId: crypto.randomUUID(),
      });
      if (template instanceof Error) throw template;
      const ready = await store.markTemplateReady(templateId);
      if (ready instanceof Error) throw ready;
    }
    const backup = join(
      agent.workspaceRoot,
      ".halo/published-backups",
      app.appId,
    );
    await fs.mkdir(join(backup, "source"), { recursive: true });
    await fs.writeFile(
      join(backup, "source", "private.txt"),
      "private source and data",
    );
    await use({
      appId: app.appId,
      backup,
      reference: join(
        agent.workspaceRoot,
        ".halo/app-publication/delete-me.json",
      ),
      runtimeToken: new AppCredentials({ secret: testAuth.secret }).issue({
        appId: app.appId,
        generation: 1,
      }),
    });
  },
});


// Durable: app deletion is irreversible; enforce owner authorization and the unpublish prerequisite.
appRemovalTest(
  "removes only the owner's unpublished app and leaves its extension until extension delete",
  async ({
    appRemoval,
    authenticatedRpc,
    rpc,
    agent,
    plane,
    appDataDir,
    vmRemoval,
  }) => {
    const { appId, backup, reference } = appRemoval;
    await expect(rpc.apps.remove({ appId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      authenticatedRpc.apps.remove({ appId: "../bad" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const workspace = await authenticatedRpc.workspace.ensure();
    await expect(
      agent.rpc.apps.remove({ appId: workspace.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "App not found" });
    expect(vmRemoval.removed.has(workspace.id)).toBe(false);
    const otherHeaders = await createAuthenticatedHeaders(
      appDataDir,
      plane.origin,
      "other-deleter@example.com",
    );
    otherHeaders.set("origin", plane.origin);
    await expect(
      createControlPlaneRpcClient(plane.origin, otherHeaders).apps.remove({
        appId,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "App not found" });
    await expect(agent.rpc.apps.remove({ appId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Unpublish"),
    });
    expect(vmRemoval.removed.has(appId)).toBe(false);
    expect(await fs.readFile(join(backup, "source/private.txt"), "utf8")).toBe(
      "private source and data",
    );
    const unshared = await agent.rpc.apps.update({ appId, published: false });
    expect(unshared).toMatchObject({ published: false, stage: "live" });
    await expect(
      agent.rpc.extensions.delete({ id: "delete-me" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("halo app remove"),
    });
    await agent.rpc.apps.remove({ appId });
    expect(vmRemoval.removed.has(appId)).toBe(true);
    expect(await agent.rpc.apps.list()).toEqual([]);
    expect(await agent.rpc.extensions.list()).toEqual([]);
    const source = join(agent.workspaceRoot, ".halo/extensions/delete-me");
    const data = join(agent.workspaceRoot, ".halo/extension-data/delete-me");
    expect(await fs.readFile(join(source, "latest.txt"), "utf8")).toBe(
      "newest source from the VM",
    );
    expect(await fs.readFile(join(data, "tandem.json"), "utf8")).toBe(
      "latest hosted data",
    );
    expect(await fs.readFile(join(backup, "source/private.txt"), "utf8")).toBe(
      "private source and data",
    );
    await expect(fs.stat(reference)).rejects.toMatchObject({ code: "ENOENT" });
    await agent.rpc.extensions.delete({ id: "delete-me" });
    expect(await agent.rpc.extensions.list()).toEqual([]);
    for (const directory of [source, data, backup])
      await expect(fs.stat(directory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    await agent.rpc.extensions.delete({ id: "delete-me" });
    await agent.rpc.extensions.reload();
    expect(await agent.rpc.extensions.list()).toEqual([]);
  },
);


// Durable: even inconsistent app records must never authorize deleting a main workspace.
appRemovalTest.extend({ appWorkspaceCollision: true })(
  "protects a main workspace even when an app record points at it",
  async ({ appRemoval, agent, vmRemoval }) => {
    await agent.rpc.apps.update({ appId: appRemoval.appId, published: false });
    await expect(
      agent.rpc.apps.remove({ appId: appRemoval.appId }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Main workspaces cannot be removed"),
    });
    expect(vmRemoval.removed.size).toBe(0);
    expect(vmRemoval.snapshots).toBe(0);
    expect(await agent.rpc.apps.list()).toMatchObject([
      { appId: appRemoval.appId, stage: "live" },
    ]);
    expect(await fs.readFile(appRemoval.reference, "utf8")).toContain(
      appRemoval.appId,
    );
    await expect(
      fs.stat(
        join(agent.workspaceRoot, ".halo/app-removals", appRemoval.appId),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);


appRemovalTest.extend({
  appWorkspaceCollision: true,
  publicationComplete: false,
})(
  "protects a main workspace when an unfinished app is cancelled",
  async ({ appRemoval, agent, vmRemoval }) => {
    const before = await agent.rpc.apps.list();
    await expect(
      agent.rpc.apps.cancel({ appId: appRemoval.appId }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Main workspaces cannot be removed"),
    });
    expect(vmRemoval.removed.size).toBe(0);
    expect(await agent.rpc.apps.list()).toEqual(before);
  },
);


appRemovalTest.extend({ publicationComplete: false })(
  "cancels an unfinished app while preserving its local project",
  async ({ appRemoval, agent, vmRemoval }) => {
    await agent.rpc.apps.cancel({ appId: appRemoval.appId });
    expect(vmRemoval.removed.has(appRemoval.appId)).toBe(true);
    expect(await agent.rpc.apps.list()).toEqual([]);
    expect(
      await fs.readFile(
        join(agent.workspaceRoot, ".halo/extensions/delete-me/private.txt"),
        "utf8",
      ),
    ).toBe("keep my local source");
    await expect(fs.stat(appRemoval.reference)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);


appRemovalTest.extend({ templateCopy: true }).for([false, true])(
  "template conflict cleanup protects main workspaces (collision: %s)",
  async (
    collision,
    {
      appRemoval,
      agent,
      vmRemoval,
      appDataDir,
      plane,
      browserHeaders,
      authenticatedRpc,
    },
  ) => {
    if (collision) {
      const workspace = await authenticatedRpc.workspace.ensure();
      using database = new DatabaseSync(join(appDataDir, "control-plane.db"));
      // A ready app copy must never delete any registered main workspace.
      database
        .prepare("UPDATE workspace SET id = ? WHERE id = ?")
        .run(appRemoval.appId, workspace.id);
    }
    const headers = new Headers(browserHeaders);
    headers.set("origin", plane.origin);
    const response = await fetch(
      `${plane.origin}/api/templates/delete-me/install`,
      { method: "POST", headers },
    );
    expect(response.status).toBe(400);
    const message = await response.text();
    if (collision) {
      expect(message).toContain("Main workspaces cannot be removed");
      expect(vmRemoval.removed.size).toBe(0);
      expect(await agent.rpc.apps.list()).toMatchObject([
        { appId: appRemoval.appId },
      ]);
    } else {
      expect(message).toContain(
        "You already have an extension named delete-me",
      );
      expect(vmRemoval.removed.has(appRemoval.appId)).toBe(true);
      expect(await agent.rpc.apps.list()).toEqual([]);
    }
    expect(
      await fs.readFile(
        join(agent.workspaceRoot, ".halo/extensions/delete-me/private.txt"),
        "utf8",
      ),
    ).toBe("keep my local source");
  },
);


// Durable: failed deletion must revoke runtime authority and remain retryable without republishing.
appRemovalTest(
  "retries app removal without losing the saved extension or reviving the VM",
  async ({ appRemoval, agent, plane, vmRemoval }) => {
    const { appId, reference, backup, runtimeToken } = appRemoval;
    await agent.rpc.apps.update({ appId, published: false });
    const definition = async () =>
      await fetch(`${plane.origin}/api/app-runtime/definition`, {
        headers: { authorization: `Bearer ${runtimeToken}` },
      });
    expect((await definition()).status).toBe(200);
    vmRemoval.failure = new Error("Cloud VM removal unavailable");
    await expect(agent.rpc.apps.remove({ appId })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(vmRemoval.removed.has(appId)).toBe(false);
    expect(await agent.rpc.apps.list()).toMatchObject([
      { appId, stage: "removing", published: false },
    ]);
    expect((await definition()).status).toBe(401);
    await expect(
      agent.rpc.apps.update({ appId, published: true }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("removed"),
    });
    await expect(
      agent.rpc.apps.publish({
        extensionId: "delete-me",
        access: { visibility: "public", members: [] },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(agent.rpc.apps.cancel({ appId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      agent.rpc.apps.readSource({ appId, name: "package.json" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("removed"),
    });
    vmRemoval.failure = undefined;
    const blocked = join(agent.workspaceRoot, ".halo/extensions/delete-me");
    await fs.mkdir(blocked, { recursive: true });
    await fs.writeFile(join(blocked, "unrelated.txt"), "do not overwrite");
    await expect(agent.rpc.apps.remove({ appId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(vmRemoval.removed.has(appId)).toBe(true);
    expect(await agent.rpc.apps.list()).toMatchObject([
      { appId, stage: "removing" },
    ]);
    expect(await fs.readFile(join(backup, "source/private.txt"), "utf8")).toBe(
      "private source and data",
    );
    expect(vmRemoval.snapshots).toBe(1);
    await fs.rm(blocked, { recursive: true });
    await agent.rpc.apps.remove({ appId });
    expect(await agent.rpc.apps.list()).toEqual([]);
    expect(await agent.rpc.extensions.list()).toEqual([]);
    expect(vmRemoval.snapshots).toBe(1);
    expect(await fs.readFile(join(blocked, "latest.txt"), "utf8")).toBe(
      "newest source from the VM",
    );
    await expect(fs.stat(reference)).rejects.toMatchObject({ code: "ENOENT" });
    await agent.rpc.extensions.delete({ id: "delete-me" });
    await expect(fs.stat(backup)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(agent.rpc.apps.remove({ appId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "App not found",
    });
  },
);


appRemovalTest.extend({ removalSupported: false })(
  "keeps the app when its host cannot remove VMs",
  async ({ appRemoval, agent, vmRemoval }) => {
    const { appId } = appRemoval;
    await agent.rpc.apps.update({ appId, published: false });
    await expect(agent.rpc.apps.remove({ appId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This Halo deployment cannot remove app VMs",
    });
    expect(vmRemoval.removed.has(appId)).toBe(false);
    expect(await agent.rpc.apps.list()).toMatchObject([{ stage: "live" }]);
  },
);


appRemovalTest.extend({ publicationComplete: false })(
  "refuses to remove an unfinished publication",
  async ({ appRemoval, agent, vmRemoval }) => {
    const { appId } = appRemoval;
    await agent.rpc.apps.update({ appId, published: false });
    await expect(agent.rpc.apps.remove({ appId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Publishing is not finished"),
    });
    expect(vmRemoval.removed.has(appId)).toBe(false);
  },
);


appRemovalTest.extend({ templateDemo: true })(
  "preserves template demos when removing apps",
  async ({ appRemoval, agent, vmRemoval }) => {
    await expect(
      agent.rpc.apps.remove({ appId: appRemoval.appId }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Template demos cannot be removed as apps",
    });
    expect(vmRemoval.removed.has(appRemoval.appId)).toBe(false);
  },
);


appRemovalTest(
  "keeps the VM when its latest extension cannot be saved",
  async ({ appRemoval, agent, vmRemoval }) => {
    await agent.rpc.apps.update({ appId: appRemoval.appId, published: false });
    vmRemoval.snapshotFailure = true;
    await expect(
      agent.rpc.apps.remove({ appId: appRemoval.appId }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Hosted snapshot is unavailable",
    });
    expect(vmRemoval.removed.has(appRemoval.appId)).toBe(false);
    expect(
      await fs.readFile(join(appRemoval.backup, "source/private.txt"), "utf8"),
    ).toBe("private source and data");
    vmRemoval.snapshotFailure = false;
    await agent.rpc.apps.remove({ appId: appRemoval.appId });
    expect(await agent.rpc.extensions.list()).toEqual([]);
  },
);


appRemovalTest(
  "does not remove an unreachable VM before saving its extension",
  async ({ appRemoval, agent, vmRemoval }) => {
    await agent.rpc.apps.update({ appId: appRemoval.appId, published: false });
    vmRemoval.available = false;
    await expect(
      agent.rpc.apps.remove({ appId: appRemoval.appId }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("App VM is not reachable"),
    });
    expect(vmRemoval.removed.has(appRemoval.appId)).toBe(false);
    vmRemoval.available = true;
    await agent.rpc.apps.remove({ appId: appRemoval.appId });
    expect(
      await fs.readFile(
        join(agent.workspaceRoot, ".halo/extensions/delete-me/latest.txt"),
        "utf8",
      ),
    ).toBe("newest source from the VM");
  },
);


async function writeStagingOverrides(webRoot: string) {
  await fs.mkdir(join(webRoot, "staging"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      join(webRoot, "index.html"),
      '<meta name="halo-environment" content="" /><main>Halo</main>',
    ),
    fs.writeFile(join(webRoot, "logo.png"), "production logo"),
    fs.writeFile(join(webRoot, "icon.png"), "production icon"),
    fs.writeFile(join(webRoot, "staging", "logo.png"), "staging logo"),
  ]);
}


const stagingPlaneTest = controlPlaneTest.extend({
  environment: "staging" as const,
});

stagingPlaneTest(
  "staging serves staging/ overrides at the root paths and marks the app shell",
  async ({ plane, webRoot }) => {
    await writeStagingOverrides(webRoot);
    const logo = await fetch(`${plane.origin}/logo.png`);
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect(await logo.text()).toBe("staging logo");
    expect(await (await fetch(`${plane.origin}/icon.png`)).text()).toBe(
      "production icon",
    );
    expect(await (await fetch(`${plane.origin}/login`)).text()).toContain(
      'name="halo-environment" content="staging"',
    );
  },
);


const marketingPlaneTest = controlPlaneTest.extend({
  googleAnalyticsMeasurementId: "G-HALOTEST",
});

marketingPlaneTest(
  "serves deployment-specific GA configuration and permits the booking and analytics hosts",
  async ({ plane, webRoot }) => {
    await fs.writeFile(
      join(webRoot, "index.html"),
      '<meta name="halo-ga-measurement-id" content="" /><main>Halo</main>',
    );
    const response = await fetch(`${plane.origin}/newsletter/check-email`);
    const body = await response.text();
    expect(body).toContain(
      'name="halo-ga-measurement-id" content="G-HALOTEST"',
    );
    expect(Number(response.headers.get("content-length"))).toBe(
      Buffer.byteLength(body),
    );
    const policy = response.headers.get("content-security-policy");
    expect(policy).toContain(
      "frame-src 'self' https://cal.com https://app.cal.com",
    );
    expect(policy).toContain("connect-src 'self' https://buttondown.com ");
    expect(policy).toContain(
      "script-src 'self' https://app.cal.com https://www.googletagmanager.com",
    );
    expect(policy).toContain("https://*.google-analytics.com");
    expect(policy).not.toContain("'unsafe-inline' https://");
    const head = await fetch(plane.origin, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe(
      response.headers.get("content-length"),
    );
    expect(await head.text()).toBe("");
  },
);


marketingPlaneTest(
  "keeps signed-in app responses and private routes free of marketing permissions",
  async ({ plane, webRoot, browserHeaders }) => {
    await fs.writeFile(
      join(webRoot, "index.html"),
      '<meta name="halo-ga-measurement-id" content="" /><main>Halo</main>',
    );
    for (const [pathname, headers] of [
      ["/", browserHeaders],
      ["/login", undefined],
      ["/settings", undefined],
    ] as const) {
      const response = await fetch(`${plane.origin}${pathname}`, { headers });
      expect(await response.text()).toContain(
        'name="halo-ga-measurement-id" content=""',
      );
      const policy = response.headers.get("content-security-policy")!;
      expect(policy).toContain("script-src 'self';");
      expect(policy).toContain("connect-src 'self';");
      expect(policy).not.toContain("googletagmanager");
      expect(policy).not.toContain("google-analytics");
      expect(policy).not.toContain("cal.com");
    }
  },
);


// Durable: protects public attribution and isolation from authenticated Halo routes.
const marketingLinkTest = controlPlaneTest.extend({
  marketingAdminUserIds: ["marketing-admin"],
});


marketingLinkTest(
  "marketing short links resolve without a workspace or sign-in",
  async ({ plane, authenticatedRpc, workspaceHost, appDataDir }) => {
    const headers = await createAuthenticatedHeaders(
      appDataDir,
      plane.origin,
      "admin@example.com",
      "marketing-admin",
    );
    headers.set("origin", plane.origin);
    const admin = createControlPlaneRpcClient(plane.origin, headers);
    const tags = {
      utm_source: "linkedin",
      utm_medium: "social",
      utm_campaign: "Halo & friends",
      utm_content: "first post",
      utm_term: "desktop",
    };
    await admin.marketing.create({ slug: "launch", tags });
    const port = new URL(plane.origin).port;
    const request = async (
      path: string,
      method = "GET",
      host = `go.localhost:${port}`,
      upgrade = false,
    ) =>
      await new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
        body: string;
      }>((complete, reject) => {
        const outgoing = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path,
            method,
            headers: upgrade
              ? { host, connection: "upgrade", upgrade: "websocket" }
              : { host },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              complete({
                status: response.statusCode!,
                headers: response.headers,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        outgoing.on("error", reject);
        outgoing.end();
      });
    for (const path of [
      "/launch",
      "/launch/",
      "/launch?utm_source=evil&url=https://evil.example&code=secret",
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await request(path, method);
        expect(response.status).toBe(302);
        const destination = new URL(response.headers.location!);
        expect(destination.origin).toBe(plane.origin);
        expect(destination.pathname).toBe("/");
        expect(Object.fromEntries(destination.searchParams)).toEqual({
          utm_source: "linkedin",
          utm_medium: "social",
          utm_campaign: "Halo & friends",
          utm_content: "first post",
          utm_term: "desktop",
        });
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(response.body).toBe("");
      }
    }
    expect(
      (await request("/launch", "GET", `GO.LOCALHOST:${port}`)).status,
    ).toBe(302);
    // Public marketing hostname isolation does not depend on a Host port spelling.
    for (const host of [
      "go.localhost:443",
      "go.localhost:12345",
      "go.localhost",
    ]) {
      expect((await request("/launch", "GET", host)).status).toBe(302);
      expect((await request("/rpc/marketing/list", "GET", host)).status).toBe(
        404,
      );
      expect(
        (await request("/workspace/health", "GET", host, true)).status,
      ).toBe(404);
    }
    for (const path of [
      "/",
      "/missing",
      "/toString",
      "/constructor",
      "/api/auth/get-session",
      "/rpc/server/info",
      "/workspace/health",
      "/launch/sync",
      "/%6caunch",
      "/other/../launch",
      "//launch",
      "/launch\\other",
    ]) {
      const response = await request(path);
      expect([path, response.status]).toEqual([path, 404]);
    }
    const post = await request("/launch", "POST");
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
    expect(
      (await request("/launch", "GET", `creator.localhost:${port}`)).status,
    ).toBe(404);
    expect((await request("/health", "GET", `127.0.0.1:${port}`)).status).toBe(
      200,
    );
    await expect(
      authenticatedRpc.apps.renamePublisher({ handle: "go" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await admin.marketing.update({
      slug: "launch",
      tags: { ...tags, utm_campaign: "updated" },
      enabled: true,
    });
    expect(
      new URL((await request("/launch")).headers.location!).searchParams.get(
        "utm_campaign",
      ),
    ).toBe("updated");
    await admin.marketing.update({ slug: "launch", tags, enabled: false });
    expect((await request("/launch")).status).toBe(404);
    expect((await request("/launch", "HEAD")).status).toBe(404);
    await admin.marketing.update({ slug: "launch", tags, enabled: true });
    expect((await request("/launch")).status).toBe(302);
    await admin.marketing.remove({ slug: "launch" });
    expect((await request("/launch")).status).toBe(404);
    expect(workspaceHost.requests).toEqual([]);
  },
);


const marketingAdminTest = controlPlaneTest.extend({
  marketingAdminUserIds: ["marketing-admin"],
});

const campaignTags = {
  utm_source: "linkedin",
  utm_medium: "social",
  utm_campaign: "launch",
};


marketingAdminTest(
  "marketing admin API creates, edits, disables and removes campaigns",
  async ({ plane, appDataDir }) => {
    const headers = await createAuthenticatedHeaders(
      appDataDir,
      plane.origin,
      "admin@example.com",
      "marketing-admin",
    );
    headers.set("origin", plane.origin);
    const admin = createControlPlaneRpcClient(plane.origin, headers);
    expect(await admin.marketing.list()).toEqual([]);
    const input = { slug: "launch", tags: campaignTags };
    expect(await admin.marketing.create(input)).toEqual({
      ...input,
      enabled: true,
    });
    const competing = await Promise.allSettled([
      admin.marketing.create({ ...input, slug: "concurrent" }),
      admin.marketing.create({ ...input, slug: "concurrent" }),
    ]);
    expect(competing.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(admin.marketing.create(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const changed = {
      ...input,
      tags: { ...campaignTags, utm_content: "new & tagged" },
      enabled: false,
    };
    expect(await admin.marketing.update(changed)).toEqual(changed);
    expect(await admin.marketing.list()).toContainEqual(changed);
    await admin.marketing.remove({ slug: "launch" });
    expect((await admin.marketing.list()).map((c) => c.slug)).toEqual([
      "concurrent",
    ]);
    await expect(admin.marketing.update(changed)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      admin.marketing.remove({ slug: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Use the actual request boundary to verify runtime schema validation.
    for (const json of [
      { ...input, slug: "../bad" },
      { ...input, tags: { ...campaignTags, utm_source: " " } },
      { ...input, ownerUserId: "forged" },
      {
        ...input,
        tags: { ...campaignTags, destination: "https://evil.example" },
      },
    ]) {
      const response = await fetch(`${plane.origin}/rpc/marketing/create`, {
        method: "POST",
        headers: {
          cookie: headers.get("cookie")!,
          origin: plane.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ json }),
      });
      expect(response.status).toBe(400);
    }
  },
);


marketingAdminTest(
  "marketing admin API rejects ordinary accounts, forged identities and cross-origin cookies",
  async ({ plane, appDataDir, authenticatedRpc, rpc }) => {
    const input = { slug: "launch", tags: campaignTags };
    for (const operation of [
      async () => await authenticatedRpc.marketing.create(input),
      async () => await authenticatedRpc.marketing.list(),
      async () =>
        await authenticatedRpc.marketing.update({ ...input, enabled: false }),
      async () => await authenticatedRpc.marketing.remove({ slug: "launch" }),
    ])
      await expect(operation()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rpc.marketing.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await authenticatedRpc.workspace.ensure();
    const regularRuntime = await readRuntimeSettings(appDataDir);
    await expect(
      createControlPlaneRpcClient(
        plane.origin,
        regularRuntime.token,
      ).marketing.list(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const headers = await createAuthenticatedHeaders(
      appDataDir,
      plane.origin,
      "admin@example.com",
      "marketing-admin",
    );
    headers.set("origin", "https://other.example");
    await expect(
      createControlPlaneRpcClient(plane.origin, headers).marketing.create(
        input,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    headers.delete("origin");
    await expect(
      createControlPlaneRpcClient(plane.origin, headers).marketing.list(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    headers.set("origin", plane.origin);
    const admin = createControlPlaneRpcClient(plane.origin, headers);
    await admin.workspace.ensure();
    const runtime = await readRuntimeSettings(appDataDir);
    const agent = createControlPlaneRpcClient(plane.origin, runtime.token);
    await agent.marketing.create(input);
    expect(await admin.marketing.list()).toEqual([{ ...input, enabled: true }]);
    await expect(
      createControlPlaneRpcClient(plane.origin, "fake-token").marketing.list(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  },
);
