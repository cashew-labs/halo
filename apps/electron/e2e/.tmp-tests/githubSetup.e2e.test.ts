import { expect } from "@playwright/test";
import { e2eTest } from "../e2eTest.js";
import { ControlPlane } from "../../../control-plane/src/server/ControlPlane.js";
import { LocalWorkspaceProvider } from "../../../control-plane/src/workspace/provider/local/LocalWorkspaceProvider.js";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ControlPlaneClient } from "@get-halo/shared/controlPlaneContract";
import { IntegrationSlug } from "@executor-js/sdk/core";
import * as errore from "errore";
import { execa } from "execa";
import fs from "node:fs/promises";
import zlib from "node:zlib";

const githubSetupTest = e2eTest.extend<{
  githubSpec: "small" | "real" | "unavailable";
  githubSetup: {
    setupUrl: string;
    cookie: string;
    origin: string;
    client: ControlPlaneClient;
    specRequests: string[];
    installationMs: number;
    tools(): Promise<string[]>;
  };
}>({
  githubSpec: "small",
  githubSetup: async ({ testArtifacts, githubSpec }, use) => {
    await using cleanup = new errore.AsyncDisposableStack();
    if (process.env.REVIEW_COVERAGE_DIR)
      await execa(
        "pnpm",
        ["--filter", "@get-halo/web-app", "build", "--sourcemap"],
        {
          cwd: path.resolve(import.meta.dirname, "../../../.."),
        },
      );
    const provider = http.createServer(async (request, response) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      if (url.pathname === "/login/oauth/authorize") {
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", url.searchParams.get("state")!);
        callback.searchParams.set("code", "fixture-github-code");
        response.writeHead(302, { location: callback.toString() }).end();
        return;
      }
      if (url.pathname !== "/login/oauth/access_token") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      expect(body.get("client_secret")).toBe("fixture-secret");
      expect(body.get("code_verifier")).toBeTruthy();
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          access_token: "fixture-token",
          token_type: "bearer",
          scope: "",
          expires_in: 3600,
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
    // SAFETY: The provider is listening on a numeric TCP port.
    const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    const auth = {
      secret: "test-control-plane-auth-secret-key!",
      googleClientId: "fixture-google-client",
      googleClientSecret: "fixture-google-secret",
    };
    const specRequests: string[] = [];
    const plane = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir: testArtifacts.paths.userData,
        port: 0,
        auth,
        github: {
          clientId: "fixture-github-client",
          clientSecret: "fixture-secret",
        },
      },
      webRoot: path.resolve(import.meta.dirname, "../../../web-app/dist"),
      workspaceProvider: new LocalWorkspaceProvider({
        appDataDir: testArtifacts.paths.userData,
      }),
      integrationEncryptionKey: Buffer.alloc(32, 17),
      allowLocalIntegrationUrls: true,
      githubOAuthOrigin: providerOrigin,
      getOpenAPISpec: async (url) => {
        specRequests.push(url);
        if (url.includes("github/rest-api-description")) {
          expect(url).toContain("bb754941722779d8a5b3a2f25a5fbb7ce794e1ea");
          if (githubSpec === "unavailable")
            return new Error("GitHub specification unavailable");
          if (githubSpec === "real")
            return zlib
              .gunzipSync(
                await fs.readFile(
                  new URL("./fixtures/github-openapi.json.gz", import.meta.url),
                ),
              )
              .toString("utf8");
          return JSON.stringify({
            openapi: "3.0.3",
            info: { title: "GitHub", version: "1" },
            servers: [{ url: providerOrigin }],
            paths: {
              "/items": {
                get: {
                  operationId: "repos/list",
                  responses: { "200": { description: "OK" } },
                },
              },
            },
          });
        }
        return JSON.stringify({
          discoveryVersion: "v1",
          id: "test:v1",
          name: "test",
          version: "v1",
          title: "Google fixture",
          rootUrl: `${providerOrigin}/`,
          servicePath: "test/",
          resources: {},
        });
      },
    });
    if (plane instanceof Error) throw plane;
    cleanup.defer(async () => {
      const closed = await plane.close();
      if (closed instanceof Error) throw closed;
    });
    using database = new DatabaseSync(
      path.join(testArtifacts.paths.userData, "control-plane.db"),
    );
    const loginAuth = betterAuth({
      baseURL: plane.origin,
      secret: auth.secret,
      database,
      plugins: [testUtils()],
    });
    const authContext = await loginAuth.$context;
    const user = authContext.test.createUser({
      email: "owner@example.com",
      name: "Workspace Owner",
    });
    await authContext.test.saveUser(user);
    const login = await authContext.test.login({ userId: user.id });
    const cookie = login.headers.get("cookie");
    if (cookie === null) throw new Error("Test sign-in returned no cookie");
    const client: ControlPlaneClient = createORPCClient(
      new RPCLink({
        origin: plane.origin,
        url: "/rpc",
        headers: { cookie, origin: plane.origin },
      }),
    );
    const startedAt = Date.now();
    await client.integrations.catalog();
    const installationMs = Date.now() - startedAt;
    const fixture = {
      cookie,
      origin: plane.origin,
      client,
      specRequests,
      installationMs,
      tools: async () => {
        const tools = await plane.integrations!.withUser(user.id, (executor) =>
          executor.tools.list({ includeBlocked: true }),
        );
        if (tools instanceof Error) throw tools;
        return tools
          .filter((tool) => tool.integration === "github")
          .map((tool) => tool.name);
      },
    };
    if (githubSpec === "unavailable") {
      await use({ ...fixture, setupUrl: "" });
      return;
    }
    const configured = await plane.integrations!.withUser(user.id, (executor) =>
      executor.openapi.configure(IntegrationSlug.make("github"), {
        mode: "replace",
        authenticationTemplate: [
          {
            slug: "githubOAuth2",
            kind: "oauth2",
            authorizationUrl: `${providerOrigin}/login/oauth/authorize`,
            tokenUrl: `${providerOrigin}/login/oauth/access_token`,
            scopes: [],
          },
        ],
      }),
    );
    if (configured instanceof Error) throw configured;
    const setup = await client.integrations.startSetup({
      integration: "github",
      connectionName: "personal",
    });
    await use({ ...fixture, setupUrl: setup.setupUrl });
  },
});

githubSetupTest(
  "chooses repositories and completes GitHub OAuth through the real setup page",
  async ({ browser, githubSetup }) => {
    const context = await browser.newContext();
    await context.addCookies(
      githubSetup.cookie.split("; ").map((cookie) => {
        const separator = cookie.indexOf("=");
        return {
          name: cookie.slice(0, separator),
          value: cookie.slice(separator + 1),
          url: githubSetup.origin,
        };
      }),
    );
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await context.close());
    const page = await context.newPage();
    if (process.env.REVIEW_COVERAGE_DIR)
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.goto(githubSetup.setupUrl);
    expect(githubSetup.specRequests).toEqual(
      expect.arrayContaining([
        "https://www.googleapis.com/discovery/v1/apis/admin/directory_v1/rest",
        "https://www.googleapis.com/discovery/v1/apis/admin/reports_v1/rest",
        "https://www.googleapis.com/discovery/v1/apis/cloudresourcemanager/v3/rest",
      ]),
    );
    await expect(
      page.getByRole("heading", { name: "Connect GitHub" }),
    ).toBeVisible();
    const install = page.getByRole("link", {
      name: "Choose repositories on GitHub",
    });
    await expect(install).toHaveAttribute(
      "href",
      "https://github.com/apps/halo-by-cashew/installations/new",
    );
    await expect(install).toHaveAttribute("target", "_blank");
    await expect(page.getByRole("textbox")).toHaveCount(0);
    const root = path.resolve(import.meta.dirname, "../../../..");
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.screenshot({
        path: path.join(
          root,
          `.context/github-setup-${viewport.width}x${viewport.height}.png`,
        ),
        fullPage: true,
      });
    }
    await page.getByRole("button", { name: "Continue to GitHub" }).click();
    await expect(
      page.getByRole("heading", { name: "GitHub connected" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Manage repository access on GitHub" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/apps/halo-by-cashew/installations/new",
    );
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.screenshot({
        path: path.join(
          root,
          `.context/github-connected-${viewport.width}x${viewport.height}.png`,
        ),
        fullPage: true,
      });
    }
    if (process.env.REVIEW_COVERAGE_DIR) {
      const fs = await import("node:fs/promises");
      const { pathToFileURL } = await import("node:url");
      const { randomUUID } = await import("node:crypto");
      const entries = (await page.coverage.stopJSCoverage())
        .filter((entry) =>
          entry.url.startsWith(`${githubSetup.origin}/assets/`),
        )
        .map((entry) => ({
          ...entry,
          url: pathToFileURL(
            path.join(root, "apps/web-app/dist", new URL(entry.url).pathname),
          ).href,
        }));
      await fs.writeFile(
        path.join(process.env.REVIEW_COVERAGE_DIR, `${randomUUID()}.json`),
        JSON.stringify(entries),
      );
    }
  },
);

githubSetupTest.extend({ githubSpec: "real" })(
  "installs the pinned full GitHub REST description within the install budget",
  async ({ browser, githubSetup }) => {
    const context = await browser.newContext();
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await context.close());
    await context.addCookies(
      githubSetup.cookie.split("; ").map((cookie) => {
        const separator = cookie.indexOf("=");
        return {
          name: cookie.slice(0, separator),
          value: cookie.slice(separator + 1),
          url: githubSetup.origin,
        };
      }),
    );
    const page = await context.newPage();
    await page.goto(githubSetup.setupUrl);
    await page.getByRole("button", { name: "Continue to GitHub" }).click();
    await expect(
      page.getByRole("heading", { name: "GitHub connected" }),
    ).toBeVisible();
    const tools = await githubSetup.tools();
    expect(tools.length).toBeGreaterThan(500);
    expect(tools.some((name) => name.includes("pulls"))).toBe(true);
    expect(githubSetup.installationMs).toBeLessThan(30_000);
  },
);

githubSetupTest.extend({ githubSpec: "unavailable" })(
  "keeps Google integrations usable when the GitHub description is unavailable",
  async ({ githubSetup }) => {
    const catalog = await githubSetup.client.integrations.catalog();
    expect(catalog.some((entry) => entry.integration === "google_gmail")).toBe(
      true,
    );
    expect(catalog.some((entry) => entry.integration === "github")).toBe(false);
  },
);
