import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { expect } from "@playwright/test";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import * as errore from "errore";
import { ControlPlane } from "../../control-plane/src/server/ControlPlane.js";
import { m } from "@get-halo/shared/testing";
import { e2eTest } from "./e2eTest.js";
import { extensionE2eTest } from "./extensionE2eTest.js";

const auth = {
  secret: "test-control-plane-auth-secret-key!",
  googleClientId: "test-google-client-id.apps.googleusercontent.com",
  googleClientSecret: "test-google-client-secret",
};

extensionE2eTest(
  "opens an owner-authenticated extension at its standalone web URL",
  async ({ browser, loadExtension, testArtifacts }) => {
    extensionE2eTest.setTimeout(120_000);
    const extension = await loadExtension("./fixtures/greeting");
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

    const frame = signedInPage.getByTitle("greeting", { exact: true });
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
