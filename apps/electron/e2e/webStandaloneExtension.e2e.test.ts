import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { expect } from "@playwright/test";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import * as errore from "errore";
import { ControlPlane } from "../../control-plane/src/server/ControlPlane.js";
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
