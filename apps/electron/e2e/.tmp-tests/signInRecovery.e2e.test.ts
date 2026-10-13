import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { expect } from "@playwright/test";
import * as errore from "errore";
import { ControlPlane } from "../../../control-plane/src/server/ControlPlane.js";
import { LocalWorkspaceProvider } from "../../../control-plane/src/workspace/provider/local/LocalWorkspaceProvider.js";
import { e2eTest } from "../e2eTest.js";
import { routeWorkspaceRpc } from "../workspaceSocket.js";
import { haloProtocolVersion } from "@get-halo/client";
import type { ControlPlaneAuth } from "../../src/main/auth/ControlPlaneAuth.js";
import type { serializeConnectionFailure } from "@get-halo/client";
import type { DesktopRequest } from "../../src/shared/desktop.js";
import type { ControlPlaneSession } from "@get-halo/shared/controlPlaneContract";

const repo = path.resolve(import.meta.dirname, "../../../..");
const session: ControlPlaneSession = {
  session: {
    id: "e2e-session",
    userId: "e2e-user",
    expiresAt: "2100-01-01T00:00:00.000Z",
  },
  user: { id: "e2e-user", email: "e2e@example.com", name: "E2E User" },
};

e2eTest(
  "keeps sign-in actionable after OAuth cancellation and resumes only after success",
  async ({ app, testArtifacts }) => {
    e2eTest.setTimeout(120_000);
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Connected",
        exact: true,
      }),
    ).toBeVisible();
    const plane = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir: path.join(testArtifacts.paths.root, "control-plane"),
        port: 0,
        auth: {
          secret: "test-control-plane-auth-secret-key!",
          googleClientId: "test-google-client-id.apps.googleusercontent.com",
          googleClientSecret: "test-google-client-secret",
        },
      },
      webRoot: path.resolve(repo, "apps/web-app/dist"),
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
    const connection = await app.page.evaluate(() =>
      window.haloDesktop.getConnection(),
    );
    const driver = await app.electron.evaluateHandle(
      async ({ app: nativeApp, ipcMain }, input) => {
        // Host boundary: run the real desktop auth service in Electron with real secure storage and loopback HTTP.
        const nativeRequire = process
          .getBuiltinModule("node:module")
          .createRequire(nativeApp.getAppPath() + "/");
        const fileSystem = nativeRequire("node:fs") as typeof import("node:fs");
        const paths = nativeRequire("node:path") as typeof import("node:path");
        const directory = paths.join(nativeApp.getAppPath(), ".vite/build");
        const modules = fileSystem
          .readdirSync(directory)
          .filter((file) => file.endsWith(".cjs"));
        function loadExport(name: string) {
          const file = modules.find((file) =>
            fileSystem
              .readFileSync(paths.join(directory, file), "utf8")
              .includes(`exports.${name} =`),
          );
          if (file === undefined)
            throw new Error(`Packaged export ${name} was not found`);
          return nativeRequire(paths.join(directory, file)) as unknown;
        }
        // Use the same packaged module as Halo so source maps and coverage have one instance.
        const bundled = {
          ...(loadExport("ControlPlaneAuth") as {
            ControlPlaneAuth: typeof ControlPlaneAuth;
          }),
          ...(loadExport("serializeConnectionFailure") as {
            serializeConnectionFailure: typeof serializeConnectionFailure;
          }),
        };
        const auth = await bundled.ControlPlaneAuth.start({
          origin: input.origin,
          sessionPath: input.sessionPath,
        });
        const urls: string[] = [];
        nativeApp.on("halo:e2e:open-external", (url: string) => urls.push(url));
        const state = {
          successful: false,
          failNextConnection: false,
          signInSucceeds: false,
          holdConnection: false,
          connectionHeld: false,
          redirectOnly: false,
          transportFailure: false,
          power: undefined as "running" | "asleep" | undefined,
          holdWake: false,
        };
        let finishWake: (() => void) | undefined;
        let finishConnection: (() => void) | undefined;
        ipcMain.removeHandler("halo:desktop");
        ipcMain.handle(
          "halo:desktop",
          async (_event, request: DesktopRequest) => {
            if (request.type === "getAuthSession") return input.session;
            if (request.type === "getConnection") {
              if (state.holdConnection) {
                state.holdConnection = false;
                return await new Promise<{
                  connectionFailure: "authentication";
                }>((resolve) => {
                  state.connectionHeld = true;
                  finishConnection = () =>
                    resolve({ connectionFailure: "authentication" });
                });
              }
              if (state.successful) {
                if (state.failNextConnection) {
                  state.failNextConnection = false;
                  return undefined;
                }
                return input.connection;
              }
              if (state.transportFailure)
                return {
                  connectionFailure: "transport",
                  message: "Test network unavailable",
                };
              const result = await auth.getWorkspaceConnection();
              return result instanceof Error
                ? bundled.serializeConnectionFailure(result)
                : result;
            }
            if (request.type === "signIn") {
              if (state.redirectOnly) return undefined;
              if (state.signInSucceeds) {
                state.signInSucceeds = false;
                state.successful = true;
                state.failNextConnection = true;
                return input.session;
              }
              if (state.successful) return input.session;
              const result = await auth.signIn();
              return result instanceof Error
                ? bundled.serializeConnectionFailure(result)
                : result;
            }
            if (request.type === "getWorkspaceStatus")
              return state.power === undefined
                ? undefined
                : { status: state.power };
            if (request.type === "recordWorkspaceActivity") {
              if (!state.holdWake) return undefined;
              return await new Promise<void>((resolve) => {
                finishWake = resolve;
              });
            }
            return undefined;
          },
        );
        return {
          auth,
          urls,
          state,
          releaseWake: () => finishWake?.(),
          releaseConnection: () => finishConnection?.(),
        };
      },
      {
        origin: plane.origin,
        sessionPath: path.join(testArtifacts.paths.root, "new-session"),
        session,
        connection,
      },
    );
    cleanup.defer(async () => await driver.dispose());

    // Reconnect from a previously usable workspace, retaining mounted content.
    await app.page.context().setOffline(true);
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Disconnected",
        exact: true,
      }),
    ).toBeVisible();
    await app.page.context().setOffline(false);
    const trigger = app.page.getByRole("button", {
      name: "Connection: Sign in required",
      exact: true,
    });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const dialog = app.page.getByRole("dialog", {
      name: "Sign in required",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    for (let tab = 0; tab < 4; tab++) {
      await app.page.keyboard.press("Tab");
      await expect(dialog.locator(":focus")).toBeVisible();
    }
    await dialog.getByText("Connection details", { exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Copy details", exact: true }),
    ).toBeVisible();
    await app.page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new Error("Test clipboard blocked");
      };
    });
    await dialog
      .getByRole("button", { name: "Copy details", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Could not copy details",
    );
    await app.page.evaluate(() => {
      navigator.clipboard.writeText = async () => {};
    });
    await dialog
      .getByRole("button", { name: "Copy details", exact: true })
      .click();
    await dialog.getByText("Connection details", { exact: true }).click();
    await app.page.setViewportSize({ width: 1280, height: 800 });
    await app.page.screenshot({
      path: path.join(repo, ".context/sign-in-desktop-1280x800.png"),
    });
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Waiting for sign-in…", exact: true }),
    ).toBeDisabled();
    await expect
      .poll(async () => await driver.evaluate(({ urls }) => urls.length))
      .toBe(1);
    const concurrent = await driver.evaluateHandle(({ auth }) => ({
      result: auth.signIn(),
    }));
    cleanup.defer(async () => await concurrent.dispose());
    // The auth queue must stay responsive while Google is open.
    expect(
      await driver.evaluate(async ({ auth }) => await auth.getSession()),
    ).toBeUndefined();
    expect(
      await driver.evaluate(async ({ auth }) => {
        const value = await auth.getWorkspaceConnection();
        return value instanceof Error ? value.message : value;
      }),
    ).toBe("Sign in to reconnect to Halo.");
    await app.page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(dialog).toBeVisible();
    const authorizationUrl = await driver.evaluate(({ urls }) => urls[0]!);
    const oauthState = new URL(authorizationUrl).searchParams.get("state");
    if (oauthState === null) throw new Error("OAuth state missing");
    const denied = new URL("/api/auth/callback/google", plane.origin);
    denied.searchParams.set("state", oauthState);
    denied.searchParams.set("error", "access_denied");
    const result = await fetch(denied);
    expect(result.status).toBe(200);
    expect(
      await concurrent.evaluate(async ({ result }) => {
        const value = await result;
        return value instanceof Error ? value.message : value;
      }),
    ).toContain("Sign-in was cancelled");
    expect(await driver.evaluate(({ urls }) => urls.length)).toBe(1);
    await expect(dialog.getByRole("alert")).toContainText(
      "Sign-in was cancelled",
    );
    await expect(
      dialog.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeEnabled();
    await app.page.screenshot({
      path: path.join(repo, ".context/sign-in-cancelled-desktop-1280x800.png"),
    });
    await app.page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeVisible();
    await expect(trigger).toBeFocused();
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.page
      .getByRole("button", { name: "Open sidebar", exact: true })
      .click();
    await trigger.click();
    await expect(dialog).toBeVisible();
    await app.page.screenshot({
      path: path.join(repo, ".context/sign-in-mobile-390x844.png"),
    });
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect
      .poll(async () => await driver.evaluate(({ urls }) => urls.length))
      .toBe(2);
    const secondUrl = await driver.evaluate(({ urls }) => urls[1]!);
    const secondDenied = new URL("/api/auth/callback/google", plane.origin);
    secondDenied.searchParams.set(
      "state",
      new URL(secondUrl).searchParams.get("state")!,
    );
    secondDenied.searchParams.set("error", "temporarily_unavailable");
    expect((await fetch(secondDenied)).status).toBe(200);
    await expect(dialog.getByRole("alert")).toContainText(
      "Halo authentication failed",
    );
    await expect(
      dialog.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeEnabled();
    await app.page.screenshot({
      path: path.join(repo, ".context/sign-in-error-mobile-390x844.png"),
    });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();
    await app.page.setViewportSize({ width: 1280, height: 800 });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(dialog).toBeVisible();
    // A browser host that redirects without returning a session must not reconnect.
    await driver.evaluate(({ state }) => {
      state.redirectOnly = true;
    });
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeEnabled();
    await driver.evaluate(({ state }) => {
      state.holdConnection = true;
    });
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect
      .poll(
        async () => await driver.evaluate(({ state }) => state.connectionHeld),
      )
      .toBe(true);
    await driver.evaluate(({ state }) => {
      state.redirectOnly = false;
      state.signInSucceeds = true;
    });
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Reconnecting…",
        exact: true,
      }),
    ).toBeVisible();
    await expect(trigger).toHaveCount(0);
    await driver.evaluate(({ releaseConnection }) => releaseConnection());
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Connected",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      app.page.getByRole("treegrid", { name: "Workspace" }),
    ).toBeVisible();

    const draft = app.page.getByLabel("Message", { exact: true });
    await draft.fill("Keep this draft when credentials refresh elsewhere");
    await driver.evaluate(({ state }) => {
      state.successful = false;
    });
    await app.page.context().setOffline(true);
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Disconnected",
        exact: true,
      }),
    ).toBeVisible();
    await app.page.context().setOffline(false);
    await expect(trigger).toBeVisible();
    await trigger.click();
    await dialog.getByText("Connection details", { exact: true }).click();
    const beforeProbe = await dialog.locator("pre").innerText();
    await driver.evaluate(({ state }) => {
      state.transportFailure = true;
    });
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(dialog.locator("pre")).not.toHaveText(beforeProbe);
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeEnabled();
    await driver.evaluate(({ state }) => {
      state.transportFailure = false;
      state.successful = true;
    });
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Connected",
        exact: true,
      }),
    ).toBeVisible();
    await expect(draft).toHaveText(
      "Keep this draft when credentials refresh elsewhere",
    );

    // A sleeping workspace may need waking after credentials are renewed elsewhere.
    await driver.evaluate(({ state }) => {
      state.successful = false;
    });
    await app.page.context().setOffline(true);
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Disconnected",
        exact: true,
      }),
    ).toBeVisible();
    await app.page.context().setOffline(false);
    await expect(trigger).toBeVisible();
    await trigger.click();
    await dialog.getByText("Connection details", { exact: true }).click();
    await app.page.clock.install();
    await driver.evaluate(({ state }) => {
      state.power = "asleep";
      state.holdWake = true;
    });
    await app.page.clock.fastForward(30_000);
    await expect(dialog.locator("pre")).toContainText('"power": "asleep"');
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(dialog.locator("pre")).toContainText('"power": "waking"');
    await expect(dialog.locator("pre")).toContainText(
      '"status": "authentication"',
    );
    await driver.evaluate(({ state, releaseWake }) => {
      state.successful = true;
      state.power = "running";
      state.holdWake = false;
      releaseWake();
    });
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Connected",
        exact: true,
      }),
    ).toBeVisible();
    await expect(draft).toHaveText(
      "Keep this draft when credentials refresh elsewhere",
    );
    await app.page.clock.resume();

    // Keep the OS credential boundary isolated: a packaged test app must not prompt for the user's Keychain.
    await app.electron.evaluate(({ safeStorage }) => {
      safeStorage.isAsyncEncryptionAvailable = async () => true;
      safeStorage.encryptStringAsync = async (text) => Buffer.from(text);
      safeStorage.decryptStringAsync = async (encrypted) => ({
        result: encrypted.toString(),
        shouldReEncrypt: false,
      });
    });
    // Complete a fresh desktop attempt using Better Auth's external-provider test login.
    const successful = await driver.evaluateHandle(({ auth }) => ({
      result: auth.signIn(),
    }));
    cleanup.defer(async () => await successful.dispose());
    await expect
      .poll(async () => await driver.evaluate(({ urls }) => urls.length))
      .toBe(3);
    const finalUrl = await driver.evaluate(({ urls }) => urls[2]!);
    const correlationRequest = new URL(
      "/api/auth/callback/google",
      plane.origin,
    );
    correlationRequest.searchParams.set(
      "state",
      new URL(finalUrl).searchParams.get("state")!,
    );
    correlationRequest.searchParams.set("error", "access_denied");
    const correlated = await fetch(correlationRequest, { redirect: "manual" });
    const location = correlated.headers.get("location");
    if (location === null) throw new Error("Callback correlation missing");
    const completion = new URL(location);
    const callback = completion.searchParams.get("callback");
    const desktopState = completion.searchParams.get("state");
    if (callback === null || desktopState === null)
      throw new Error("Desktop correlation missing");
    for (const kind of [
      "state",
      "path",
      "method",
      "missing-code",
      "empty-code",
    ]) {
      const malformed = new URL(callback);
      malformed.searchParams.set(
        "state",
        kind === "state" ? "incorrect" : desktopState,
      );
      if (kind === "path") malformed.pathname = "/wrong-path";
      if (kind === "empty-code") malformed.searchParams.set("code", "");
      expect(
        (await fetch(malformed, { method: kind === "method" ? "POST" : "GET" }))
          .status,
      ).toBe(400);
    }
    using database = new DatabaseSync(
      path.join(testArtifacts.paths.root, "control-plane/control-plane.db"),
    );
    const login = betterAuth({
      baseURL: plane.origin,
      secret: "test-control-plane-auth-secret-key!",
      database,
      plugins: [testUtils()],
    });
    const context = await login.$context;
    const user = context.test.createUser({
      id: "e2e-user",
      email: "e2e@example.com",
      name: "E2E User",
    });
    await context.test.saveUser(user);
    const browserSession = await context.test.login({ userId: user.id });
    completion.pathname = "/api/desktop-auth/complete";
    completion.searchParams.delete("error");
    expect(
      (await fetch(completion, { headers: browserSession.headers })).status,
    ).toBe(200);
    expect(
      await successful.evaluate(async ({ result }) => await result),
    ).toMatchObject({ user: { email: "e2e@example.com" } });
    expect(
      await driver.evaluate(async ({ auth }) => await auth.getSession()),
    ).toMatchObject({ user: { email: "e2e@example.com" } });
  },
);

e2eTest(
  "restores the initial sign-in button when no session is returned",
  async ({ app }) => {
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Connected",
        exact: true,
      }),
    ).toBeVisible();
    await app.electron.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("halo:desktop");
      ipcMain.handle("halo:desktop", () => undefined);
    });
    await app.page.reload();
    await expect(
      app.page.getByRole("main", { name: "Sign in to Halo", exact: true }),
    ).toBeVisible();
    const button = app.page.getByRole("button", {
      name: "Continue with Google",
      exact: true,
    });
    await button.click();
    await expect(button).toBeEnabled();
    await expect(
      app.page.getByRole("button", {
        name: "Waiting for Google…",
        exact: true,
      }),
    ).toHaveCount(0);
  },
);

e2eTest(
  "uses the modal for protocol mismatches and retries after the server is updated",
  async ({ app }) => {
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Connected",
        exact: true,
      }),
    ).toBeVisible();
    let incompatible = false;
    const info = {
      protocolVersion: haloProtocolVersion - 1,
      supportedProtocols: [haloProtocolVersion - 1],
    };
    await app.page.route("**/rpc/server/info", async (route) => {
      if (!incompatible) {
        await route.continue();
        return;
      }
      await route.fulfill({ json: { json: info } });
    });
    await routeWorkspaceRpc(app.page, async (request) => {
      if (request.path !== "/server/info" || !incompatible) {
        request.continue();
        return;
      }
      request.fulfill({ json: info });
    });
    await app.page.reload();
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Connected",
        exact: true,
      }),
    ).toBeVisible();
    incompatible = true;
    await app.page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    const trigger = app.page.getByRole("button", {
      name: "Connection: Server update required",
      exact: true,
    });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const dialog = app.page.getByRole("dialog", {
      name: "Server update required",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    incompatible = false;
    await dialog
      .getByRole("button", { name: "Retry now", exact: true })
      .click();
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Connected",
        exact: true,
      }),
    ).toBeVisible();
  },
);
