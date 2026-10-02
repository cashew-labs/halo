import { messageText } from "@get-halo/workspace-server/testing";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { expect } from "@playwright/test";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import * as errore from "errore";
import { ControlPlane } from "../../control-plane/src/server/ControlPlane.js";
import { m } from "@get-halo/shared/testing";
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
  "completes an integration connection through same-tab web OAuth",
  async ({ browser, harness, http, llm, testArtifacts }) => {
    e2eTest.setTimeout(60_000);
    const session = await harness.loadSession({
      title: "Drive search",
      messages: [
        m.user("Find my planning document"),
        m.connectionRequest({
          client: "first-party:google",
          clientOwner: "org",
          owner: "user",
          connectionName: "default",
          integration: "google_drive",
          template: "googleOAuth2",
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
    await page.route("https://accounts.google.com/**", async (route) => {
      const authorizationUrl = new URL(route.request().url());
      const callbackValue = authorizationUrl.searchParams.get("redirect_uri");
      const state = authorizationUrl.searchParams.get("state");
      if (callbackValue === null || state === null) {
        throw new Error("OAuth authorization request was incomplete");
      }
      const callback = new URL(callbackValue);
      callback.searchParams.set("code", "accepted-code");
      callback.searchParams.set("state", state);
      await route.fulfill({
        body: `<main><a href="${callback.toString()}">Authorize Halo</a></main>`,
        contentType: "text/html; charset=utf-8",
      });
    });
    const authorizationRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.origin === "https://accounts.google.com" &&
        url.pathname === "/o/oauth2/v2/auth"
      );
    });
    await card
      .getByRole("button", { name: "Connect" })
      .click({ noWaitAfter: true });
    const authorizationUrl = new URL((await authorizationRequest).url());
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "e2e-google-web-client",
    );
    const callbackValue = authorizationUrl.searchParams.get("redirect_uri");
    if (callbackValue === null) {
      throw new Error("OAuth authorization request was incomplete");
    }
    const callback = new URL(callbackValue);
    expect(callback.origin).toBe(plane.origin);
    expect(callback.pathname).toBe("/workspace/oauth/callback");

    const tokenRequest = http.request("/token");
    await page
      .getByRole("link", { name: "Authorize Halo" })
      .click({ noWaitAfter: true });
    const token = await tokenRequest;
    token.respond(
      JSON.stringify({
        access_token: "test-access-token",
        expires_in: 3_600,
        scope: authorizationUrl.searchParams.get("scope"),
        token_type: "Bearer",
      }),
      { contentType: "application/json" },
    );

    await page.waitForURL(`${plane.origin}/#/sessions/${session.sessionId}`);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("sessions-shell")).toBeVisible({
      timeout: 10_000,
    });
    const returnedCard = page.getByRole("region", {
      name: "Google Drive connection",
    });
    await expect(
      returnedCard.getByText("Connected", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await llm.respond(m.assistant("The connection is ready."));
  },
);

for (const { action, verificationFailure } of [
  { action: "add", verificationFailure: false },
  { action: "add", verificationFailure: true },
  { action: "reauthorize", verificationFailure: false },
  { action: "switch-default", verificationFailure: false },
] as const) {
  e2eTest(
    verificationFailure
      ? "keeps saved Gmail authorization truthful after a profile outage"
      : action === "add"
        ? "adds Gmail accounts through same-tab web OAuth and preserves the default"
        : `updates Gmail card identity after ${action}`,
    async ({ browser, harness, http, llm, testArtifacts }, testInfo) => {
      e2eTest.setTimeout(60_000);
      const session = await harness.loadSession({
        title: "Gmail accounts",
        messages: [
          m.user(
            "Connect both Gmail accounts, then use the second as my default",
          ),
          m.connectionRequest({
            client: "first-party:google",
            clientOwner: "org",
            owner: "user",
            connectionName: "default",
            identityLabel: "requested@example.com",
            integration: "google_gmail",
            template: "googleOAuth2",
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

      const card = page.getByTestId("executor-connection-card");
      await page.route("https://accounts.google.com/**", async (route) => {
        const authorizationUrl = new URL(route.request().url());
        const callbackValue = authorizationUrl.searchParams.get("redirect_uri");
        const state = authorizationUrl.searchParams.get("state");
        if (callbackValue === null || state === null) {
          throw new Error("OAuth authorization request was incomplete");
        }
        const callback = new URL(callbackValue);
        callback.searchParams.set("code", "accepted-code");
        callback.searchParams.set("state", state);
        await route.fulfill({
          body: `<main><a href="${callback.toString()}">Authorize Halo</a></main>`,
          contentType: "text/html; charset=utf-8",
        });
      });
      for (const email of ["first@example.com", "second@example.com"]) {
        const separateCard = email === "second@example.com" && action !== "add";
        const activeSession = separateCard
          ? await harness.loadSession({
              title: `Gmail ${action}`,
              messages: [
                m.user(
                  action === "reauthorize"
                    ? "Reauthorize the saved Gmail account"
                    : "Add a Gmail account and make it default",
                ),
                m.connectionRequest({
                  client: "first-party:google",
                  clientOwner: "org",
                  owner: "user",
                  connectionName: "default",
                  integration: "google_gmail",
                  template: "googleOAuth2",
                  action,
                  identityLabel:
                    action === "reauthorize" ? "first@example.com" : undefined,
                }),
              ],
            })
          : session;
        if (separateCard)
          await page.goto(
            `${plane.origin}/#/sessions/${activeSession.sessionId}`,
          );
        const authorizationRequest = page.waitForRequest((request) => {
          const url = new URL(request.url());
          return (
            url.origin === "https://accounts.google.com" &&
            url.pathname === "/o/oauth2/v2/auth"
          );
        });
        if (email === "first@example.com" || separateCard) {
          await card
            .getByRole("button", {
              name: separateCard
                ? action === "reauthorize"
                  ? "Reauthorize"
                  : "Add and use as default"
                : "Add account",
              exact: true,
            })
            .click({ noWaitAfter: true });
        } else {
          await card
            .getByRole("button", { name: "first@example.com actions" })
            .click();
          await page
            .getByRole("menuitem", { name: "Add another account" })
            .click({ noWaitAfter: true });
        }
        const authorizationUrl = new URL((await authorizationRequest).url());
        expect(authorizationUrl.searchParams.get("client_id")).toBe(
          "e2e-google-web-client",
        );
        const callbackValue = authorizationUrl.searchParams.get("redirect_uri");
        if (callbackValue === null) {
          throw new Error("OAuth authorization request was incomplete");
        }
        const callback = new URL(callbackValue);
        expect(callback.origin).toBe(plane.origin);
        expect(callback.pathname).toBe("/workspace/oauth/callback");

        const tokenRequest = http.request("/token");
        await page
          .getByRole("link", { name: "Authorize Halo" })
          .click({ noWaitAfter: true });
        const token = await tokenRequest;
        token.respond(
          JSON.stringify({
            access_token: "test-access-token",
            expires_in: 3_600,
            scope: authorizationUrl.searchParams.get("scope"),
            token_type: "Bearer",
          }),
          { contentType: "application/json" },
        );

        const unverified =
          verificationFailure && email === "second@example.com";
        const changesDefaultIdentity =
          email === "second@example.com" && action !== "add";
        const defaultIdentity = changesDefaultIdentity
          ? email
          : "first@example.com";
        const verb =
          separateCard && action === "reauthorize" ? "Reauthorized" : "Added";
        const mismatch = !(separateCard && action === "switch-default");
        const completionMessage = unverified
          ? "Authorization saved. Gmail identity or default selection could not be confirmed. The saved account is unverified; reauthorize this saved account to retry."
          : `${verb} ${email}. Default: ${defaultIdentity}.${mismatch ? " The authorized account differs from the requested account; no default switch was applied." : ""}`;
        const profile = await http.request("/gmail/v1/users/me/profile");
        profile.respond(JSON.stringify({ emailAddress: email }), {
          contentType: "application/json",
          status: unverified ? 503 : 200,
        });

        await page.waitForURL(
          `${plane.origin}/#/sessions/${activeSession.sessionId}`,
        );
        await page.waitForLoadState("domcontentloaded");
        await expect(page.getByTestId("sessions-shell")).toBeVisible({
          timeout: 10_000,
        });
        const actualIdentity = unverified ? "Unverified account" : email;
        const returnedCard = page.getByRole("region", {
          name: `${actualIdentity} connection`,
          exact: true,
        });
        await expect(
          returnedCard.getByText(actualIdentity, { exact: true }),
        ).toBeVisible();
        await expect(
          returnedCard.getByRole("button", {
            name: `${actualIdentity} actions`,
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          returnedCard.getByText("requested@example.com", { exact: true }),
        ).toHaveCount(0);
        await expect(
          returnedCard.getByText(
            unverified ? "Saved · unverified" : "Connected",
            { exact: true },
          ),
        ).toBeVisible({ timeout: 10_000 });
        await expect(returnedCard.getByRole("status")).toHaveText(
          completionMessage,
        );
        await llm.respond(({ messages }) => {
          expect(JSON.stringify(messages)).toContain(completionMessage);
          return email === "first@example.com"
            ? m.assistant("The connection is ready.")
            : m.tool.start("exec", {
                id: "select-gmail-default",
                arguments: {
                  js: `const accounts = await tools.halo.listGmailAccounts({});
if (!accounts.ok) return accounts;
if (${verificationFailure || action !== "add"}) return accounts.data.map(account => ({ name: account.name, address: account.address, email: account.identityLabel, isDefault: account.isDefault }));
const second = accounts.data.find(account => account.identityLabel === "second@example.com");
const selected = await tools.halo.setDefaultGmailAccount({ accountName: second.name });
if (!selected.ok) return selected;
const after = await tools.halo.listGmailAccounts({});
if (!after.ok) return after;
return after.data.map(account => ({ name: account.name, address: account.address, email: account.identityLabel, isDefault: account.isDefault }));`,
                },
              });
        });
        if (email === "second@example.com") {
          await llm.respond(({ messages }) => {
            const result = messages.findLast(
              (message) => message.role === "tool",
            );
            expect(result).toBeDefined();
            expect(messageText(result!)).toMatch(/"name":\s*"default"/);
            expect(messageText(result!)).toContain(
              "tools.google_gmail.user.default",
            );
            if (action !== "reauthorize") {
              expect(messageText(result!)).toMatch(
                /"name":\s*"account[a-f0-9]+"/,
              );
              expect(messageText(result!)).toContain("first@example.com");
              expect(messageText(result!)).toMatch(/"isDefault":\s*false/);
            } else {
              expect(messageText(result!)).not.toContain("first@example.com");
            }
            expect(messageText(result!)).toContain(
              verificationFailure ? "Unverified account" : "second@example.com",
            );
            expect(messageText(result!)).toMatch(/"isDefault":\s*true/);
            return m.assistant("The connection is ready.");
          });
          if (unverified) {
            await page.reload();
            await expect(
              page
                .getByRole("region", { name: "Unverified account connection" })
                .getByText("Saved · unverified", { exact: true }),
            ).toBeVisible();
            await expect(
              page
                .getByRole("region", { name: "Unverified account connection" })
                .getByRole("status"),
            ).toHaveText(completionMessage);
          }
        }
        await expect(
          page.getByText("The connection is ready.").first(),
        ).toBeVisible();
      }
      await testInfo.attach("Gmail accounts", {
        body: await page.screenshot({
          path: verificationFailure
            ? path.resolve(
                import.meta.dirname,
                "../../../tmp/gmail-multi-account/unverified-card.png",
              )
            : undefined,
        }),
        contentType: "image/png",
      });
    },
  );
}

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
