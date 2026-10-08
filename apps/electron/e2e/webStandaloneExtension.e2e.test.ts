import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect } from "@playwright/test";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import * as errore from "errore";
import { ControlPlane } from "../../control-plane/src/server/ControlPlane.js";
import { LocalWorkspaceProvider } from "../../control-plane/src/workspace/provider/local/LocalWorkspaceProvider.js";
import { m } from "@get-halo/shared/testing";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ControlPlaneClient } from "@get-halo/shared/controlPlaneContract";
import { e2eTest } from "./e2eTest.js";

const auth = {
  secret: "test-control-plane-auth-secret-key!",
  googleClientId: "test-google-client-id.apps.googleusercontent.com",
  googleClientSecret: "test-google-client-secret",
};

e2eTest(
  "opens an owner-authenticated extension at its standalone web URL",
  async ({ browser, harness, testArtifacts }) => {
    e2eTest.setTimeout(120_000);
    const extension = await harness.loadExtension("./fixtures/greeting");
    const plane = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir: testArtifacts.paths.userData,
        port: 0,
        auth,
      },
      webRoot: path.resolve(import.meta.dirname, "../../web-app/dist"),
      workspaceProvider: new LocalWorkspaceProvider({
        appDataDir: testArtifacts.paths.userData,
      }),
    });
    if (plane instanceof Error) throw plane;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const closed = await plane.close();
      if (closed instanceof Error) throw closed;
    });

    const route = `/extensions/${encodeURIComponent(extension.id)}`;
    const signedOutContext = await browser.newContext();
    cleanup.defer(async () => await signedOutContext.close());
    const signedOutPage = await signedOutContext.newPage();
    const workspaceRequests: string[] = [];
    signedOutPage.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/workspace/")) {
        workspaceRequests.push(request.url());
      }
    });
    await signedOutPage.goto(new URL(route, plane.origin).toString());
    await expect(
      signedOutPage.getByRole("main", { name: "Sign in to Halo" }),
    ).toBeVisible();

    await signedOutPage.route(
      "https://accounts.google.com/**",
      async (request) => await request.abort(),
    );
    const signInRequest = signedOutPage.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/auth/sign-in/social",
    );
    const googleRequest = signedOutPage.waitForRequest(
      (request) =>
        new URL(request.url()).origin === "https://accounts.google.com",
    );
    await signedOutPage
      .getByRole("button", { name: "Continue with Google" })
      .click({ noWaitAfter: true });
    const started = await signInRequest;
    expect(started.postDataJSON()).toMatchObject({
      callbackURL: new URL(route, plane.origin).toString(),
      provider: "google",
    });
    await googleRequest;
    expect(workspaceRequests).toEqual([]);

    const cookie = await createAuthenticatedCookie({
      appDataDir: testArtifacts.paths.userData,
      origin: plane.origin,
    });
    const signedInContext = await browser.newContext({
      extraHTTPHeaders: { cookie },
    });
    cleanup.defer(async () => await signedInContext.close());
    const signedInPage = await signedInContext.newPage();
    await signedInPage.goto(new URL(route, plane.origin).toString());

    await signedInPage.setViewportSize({ width: 390, height: 844 });
    const frame = signedInPage.locator('iframe[title="greeting"]');
    await expect(frame).toHaveCSS("height", "844px");
    await expect(frame).toHaveAttribute(
      "src",
      /\/workspace\/extensions\/greeting\/view\/$/,
    );
    await expect(signedInPage.getByTestId("sessions-shell")).toHaveCount(0);
    const extensionPage = frame.contentFrame();
    await extensionPage.getByRole("textbox", { name: "Your name" }).fill("Ada");
    await extensionPage
      .getByRole("button", { name: "Greet", exact: true })
      .click();
    await expect(extensionPage.getByRole("status")).toHaveText("Hello, Ada!");

    await signedInPage.goto(
      new URL("/extensions/not-running", plane.origin).toString(),
    );
    await expect(
      signedInPage.getByText("Extension 'not-running' is not running."),
    ).toBeVisible();
  },
);

async function createAuthenticatedCookie(ctx: {
  appDataDir: string;
  origin: string;
}) {
  using database = new DatabaseSync(
    path.join(ctx.appDataDir, "control-plane.db"),
  );
  const testAuth = betterAuth({
    baseURL: ctx.origin,
    secret: auth.secret,
    database,
    plugins: [testUtils()],
  });
  const context = await testAuth.$context;
  const user = context.test.createUser({
    email: "owner@example.com",
    name: "Workspace Owner",
  });
  await context.test.saveUser(user);
  const login = await context.test.login({ userId: user.id });
  const cookie = login.headers.get("cookie");
  if (cookie === null) throw new Error("Test sign-in did not return a cookie");
  return cookie;
}

e2eTest(
  "opens a workspace extension WebSocket through the standalone web URL",
  async ({ browser, harness, testArtifacts }) => {
    e2eTest.setTimeout(120_000);
    const extension = await harness.loadExtension(
      "./fixtures/websocket-greeting",
    );
    const plane = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir: testArtifacts.paths.userData,
        port: 0,
        auth,
      },
      webRoot: path.resolve(import.meta.dirname, "../../web-app/dist"),
      workspaceProvider: new LocalWorkspaceProvider({
        appDataDir: testArtifacts.paths.userData,
      }),
    });
    if (plane instanceof Error) throw plane;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const closed = await plane.close();
      if (closed instanceof Error) throw closed;
    });

    const cookie = await createAuthenticatedCookie({
      appDataDir: testArtifacts.paths.userData,
      origin: plane.origin,
    });
    const context = await browser.newContext({
      extraHTTPHeaders: { cookie },
    });
    cleanup.defer(async () => await context.close());
    const page = await context.newPage();
    await page.goto(
      new URL(
        `/extensions/${encodeURIComponent(extension.id)}`,
        plane.origin,
      ).toString(),
    );

    const frame = page.getByTitle("WebSocket Greeting", { exact: true });
    await expect(frame).toHaveAttribute(
      "src",
      /\/workspace\/extensions\/websocket-greeting\/view\/$/,
    );
    await expect(frame.contentFrame().getByRole("status")).toHaveText(
      "Hello from WebSocket",
    );
  },
);

e2eTest(
  "confirms a saved connection without asking the user to reconnect",
  async ({ browser, testArtifacts }, testInfo) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const provider = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          openapi: "3.0.0",
          info: { title: "Example API", version: "1" },
          servers: [{ url: `http://${request.headers.host}` }],
          components: {
            securitySchemes: {
              key: { type: "apiKey", in: "header", name: "X-Api-Key" },
            },
          },
          security: [{ key: [] }],
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
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    cleanup.defer(async () => {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        provider.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    });
    // SAFETY: The provider is listening on a TCP port.
    const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    const plane = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir: testArtifacts.paths.userData,
        port: 0,
        auth,
      },
      webRoot: path.resolve(import.meta.dirname, "../../web-app/dist"),
      workspaceProvider: new LocalWorkspaceProvider({
        appDataDir: testArtifacts.paths.userData,
      }),
      integrationEncryptionKey: Buffer.alloc(32, 17),
      allowLocalIntegrationUrls: true,
      getOpenAPISpec: async () =>
        JSON.stringify({
          discoveryVersion: "v1",
          id: "test:v1",
          name: "test",
          version: "v1",
          title: "Google fixture",
          rootUrl: `${providerOrigin}/`,
          servicePath: "test/",
          resources: {},
        }),
    });
    if (plane instanceof Error) throw plane;
    cleanup.defer(async () => {
      const closed = await plane.close();
      if (closed instanceof Error) throw closed;
    });
    const cookie = await createAuthenticatedCookie({
      appDataDir: testArtifacts.paths.userData,
      origin: plane.origin,
    });
    const client: ControlPlaneClient = createORPCClient(
      new RPCLink({
        origin: plane.origin,
        url: "/rpc",
        headers: { cookie, origin: plane.origin },
      }),
    );
    await client.integrations.registerOpenAPI({
      name: "Example API",
      slug: "example-api",
      url: `${providerOrigin}/spec`,
    });
    const setup = await client.integrations.startSetup({
      integration: "example-api",
      connectionName: "personal",
    });
    using database = new DatabaseSync(
      path.join(testArtifacts.paths.userData, "control-plane.db"),
    );
    database.exec(
      "CREATE TRIGGER fail_setup_write BEFORE UPDATE ON halo_integration_setup WHEN NEW.status='ready' BEGIN SELECT RAISE(ABORT, 'fixture setup write failed'); END;",
    );
    const context = await browser.newContext({
      extraHTTPHeaders: { cookie },
      viewport: { width: 960, height: 640 },
      deviceScaleFactor: 2,
    });
    cleanup.defer(async () => await context.close());
    const page = await context.newPage();
    await page.goto(setup.setupUrl);
    await page.getByLabel("token", { exact: true }).fill("fixture-api-key");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "Connection saved; confirming status…",
    );
    await expect(
      page.getByRole("button", { name: /Connect|Cancel/ }),
    ).toHaveCount(0);
    await testInfo.attach("connection-confirming", {
      body: await page.screenshot({
        path: testInfo.outputPath("connection-confirming.png"),
      }),
      contentType: "image/png",
    });
    await page.reload();
    await expect(page.getByRole("status")).toContainText(
      "Connection saved; confirming status…",
    );
    database.exec("DROP TRIGGER fail_setup_write");
    await expect(
      page.getByRole("heading", { name: "Example API connected" }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toContainText(
      "Your connection is ready",
    );
    await testInfo.attach("connection-ready", {
      body: await page.screenshot({
        path: testInfo.outputPath("connection-ready.png"),
      }),
      contentType: "image/png",
    });
    expect(await client.integrations.connections()).toHaveLength(1);
  },
);

e2eTest(
  "opens remote integration setup in a new tab without leaving the session",
  async ({ browser, harness, testArtifacts }) => {
    e2eTest.setTimeout(60_000);
    const session = await harness.loadSession({
      title: "Drive search",
      messages: [
        m.user("Find my planning document"),
        m.connectionRequest({
          kind: "control-plane",
          connectionName: "default",
          integration: "google_drive",
        }),
      ],
    });
    const plane = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir: testArtifacts.paths.userData,
        port: 0,
        auth,
      },
      webRoot: path.resolve(import.meta.dirname, "../../web-app/dist"),
      workspaceProvider: new LocalWorkspaceProvider({
        appDataDir: testArtifacts.paths.userData,
      }),
    });
    if (plane instanceof Error) throw plane;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const closed = await plane.close();
      if (closed instanceof Error) throw closed;
    });

    const cookie = await createAuthenticatedCookie({
      appDataDir: testArtifacts.paths.userData,
      origin: plane.origin,
    });
    const context = await browser.newContext({
      extraHTTPHeaders: { cookie },
    });
    cleanup.defer(async () => await context.close());
    const page = await context.newPage();
    await page.goto(`${plane.origin}/#/sessions/${session.sessionId}`);

    const card = page.getByRole("region", {
      name: "Google Drive connection",
    });
    await expect(card).toBeVisible({ timeout: 10_000 });
    const setupUrl = `${plane.origin}/integrations/setup/browser-launch`;
    // This browser-host scenario controls the remote launch response at the
    // transport boundary; control-plane tests cover setup and OAuth completion.
    await page.route("**/rpc/thread/startConnection", async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        json: {
          sessionId: session.sessionId,
          request: {
            kind: "control-plane",
            integration: "google_drive",
            connectionName: "default",
          },
        },
      });
      await route.fulfill({
        json: {
          json: {
            status: "authorization-required",
            authorizationUrl: setupUrl,
            connectionId: "browser-launch",
            expiresAt: Date.now() + 60_000,
            wasConnected: false,
          },
        },
      });
    });
    await context.route(setupUrl, async (route) => {
      await route.fulfill({
        body: "<main><h1>Set up Google Drive</h1></main>",
        contentType: "text/html; charset=utf-8",
      });
    });
    const popup = context.waitForEvent("page");
    await card
      .getByRole("button", { name: "Connect" })
      .click({ noWaitAfter: true });
    const setupPage = await popup;
    await expect(setupPage).toHaveURL(setupUrl);
    await expect(
      setupPage.getByRole("heading", { name: "Set up Google Drive" }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      `${plane.origin}/#/sessions/${session.sessionId}`,
    );
    await expect(card).toBeVisible();
  },
);
