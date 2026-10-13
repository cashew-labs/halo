import fs from "node:fs/promises";
import nodePath from "node:path";
import { expect } from "@playwright/test";
import type { ElectronTestApp } from "../ElectronTestApp.js";
import { e2eTest } from "../e2eTest.js";

// Swaps the main-process desktop IPC handler so a test can fail one request
// type. Electron stores ipcMain.handle callbacks in an internal map.
async function overrideDesktopApi(
  app: ElectronTestApp,
  overrides: { signOutError?: string; connectionFailure?: "authentication" },
) {
  await app.electron.evaluate(({ ipcMain }, overrides) => {
    type Handler = (event: unknown, request: { type: string }) => unknown;
    // SAFETY: Electron's ipcMain keeps invoke handlers in this private Map.
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, Handler> }
    )._invokeHandlers;
    const saved = globalThis as { haloDesktopHandler?: Handler };
    saved.haloDesktopHandler ??= handlers.get("halo:desktop");
    const original = saved.haloDesktopHandler!;
    handlers.set("halo:desktop", async (event, request) => {
      if (request.type === "signOut" && overrides.signOutError !== undefined)
        throw new Error(overrides.signOutError);
      if (
        request.type === "getConnection" &&
        overrides.connectionFailure !== undefined
      )
        return { connectionFailure: overrides.connectionFailure };
      return await original(event, request);
    });
  }, overrides);
}

const screenshots = nodePath.resolve(
  import.meta.dirname,
  "../../../../tmp/staging-indicator",
);

e2eTest(
  "the footer shows the account, which signs out to the sign-in page and back",
  async ({ app }) => {
    await fs.mkdir(screenshots, { recursive: true });
    await app.page.setViewportSize({ width: 1280, height: 800 });
    const account = app.page.getByTestId("account-button");
    await expect(account).toHaveText(/e2e@example\.com/);
    await expect(account).toHaveAccessibleName("Account: e2e@example.com");
    // The account row sits above the version row in the footer.
    const version = app.page
      .getByTestId("app-update-status")
      .getByText(/^\d+\.\d+\.\d+$/);
    const accountBox = await account.boundingBox();
    const versionBox = await version.boundingBox();
    if (accountBox === null || versionBox === null)
      throw new Error("footer is not rendered");
    expect(accountBox.y + accountBox.height).toBeLessThanOrEqual(versionBox.y);
    await app.page.screenshot({
      path: nodePath.join(screenshots, "account-footer-desktop-1280x800.png"),
    });
    await app.page.getByTestId("app-update-status").screenshot({
      path: nodePath.join(screenshots, "account-footer-closeup.png"),
    });

    await account.click();
    const dialog = app.page.getByRole("dialog", { name: "Account" });
    await expect(dialog.getByText("E2E User")).toBeVisible();
    await expect(dialog.getByText("e2e@example.com")).toBeVisible();
    // Test builds use a local identity, not a deployment.
    await expect(
      dialog.getByText("Signed in with a local development identity."),
    ).toBeVisible();
    await app.page.waitForTimeout(300);
    await app.page.screenshot({
      path: nodePath.join(screenshots, "account-modal-desktop-1280x800.png"),
    });

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);

    await account.click();
    await dialog.getByRole("button", { name: "Sign out" }).click();
    const signIn = app.page.getByRole("main", { name: "Sign in to Halo" });
    await expect(signIn).toBeVisible();
    await expect(account).toHaveCount(0);
    await app.page.screenshot({
      path: nodePath.join(screenshots, "signed-out-desktop-1280x800.png"),
    });
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.page.screenshot({
      path: nodePath.join(screenshots, "signed-out-mobile-390x844.png"),
    });

    // The local test identity signs straight back in.
    await signIn.getByRole("button", { name: "Continue with Google" }).click();
    await expect(signIn).toHaveCount(0);

    // At phone width the sidebar opens as a drawer from the header's menu button.
    await app.page.getByRole("button", { name: "Open sidebar" }).click();
    const drawer = app.page.getByRole("dialog", {
      name: "Workspace navigation",
    });
    const drawerAccount = drawer.getByTestId("account-button");
    await expect(drawerAccount).toBeInViewport({ ratio: 1 });
    await app.page.waitForTimeout(500);
    await app.page.screenshot({
      path: nodePath.join(screenshots, "account-footer-mobile-390x844.png"),
    });
    await drawerAccount.click();
    await expect(dialog.getByText("e2e@example.com")).toBeVisible();
    await app.page.waitForTimeout(300);
    await app.page.screenshot({
      path: nodePath.join(screenshots, "account-modal-mobile-390x844.png"),
    });
  },
);

e2eTest(
  "on staging the account row sits above the Staging label and clips long emails",
  async ({ app, testArtifacts }) => {
    await fs.writeFile(
      nodePath.join(testArtifacts.paths.userData, "release-channel"),
      "staging\n",
    );
    await app.quit();
    await app.open();
    await app.page.setViewportSize({ width: 1280, height: 800 });
    const account = app.page.getByTestId("account-button");
    await expect(account).toBeVisible();
    await expect(app.page.getByTestId("app-release-channel")).toHaveText(
      "Staging",
    );
    const email = account.getByText("e2e@example.com");
    // The email is clipped by its button rather than widening the sidebar.
    const clipped = await email.evaluate(
      (element) =>
        getComputedStyle(element).textOverflow === "ellipsis" &&
        getComputedStyle(element).overflow === "hidden",
    );
    expect(clipped).toBe(true);
    await app.page.screenshot({
      path: nodePath.join(
        screenshots,
        "account-footer-staging-desktop-1280x800.png",
      ),
    });
  },
);

e2eTest(
  "a failed sign out shows the error and keeps the account signed in",
  async ({ app }) => {
    await app.page.setViewportSize({ width: 1280, height: 800 });
    const account = app.page.getByTestId("account-button");
    await expect(account).toBeVisible();
    await overrideDesktopApi(app, {
      signOutError: "the saved session file is read-only",
    });
    await account.click();
    const dialog = app.page.getByRole("dialog", { name: "Account" });
    await dialog.getByRole("button", { name: "Sign out" }).click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText("Halo could not sign out");
    await expect(
      dialog.getByRole("button", { name: "Sign out" }),
    ).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "Close" })).toBeEnabled();
    await expect(
      app.page.getByRole("main", { name: "Sign in to Halo" }),
    ).toHaveCount(0);
    await app.page.waitForTimeout(300);
    await app.page.screenshot({
      path: nodePath.join(screenshots, "sign-out-error-desktop-1280x800.png"),
    });
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(account).toBeVisible();
  },
);

e2eTest(
  "signing in again from the connection status keeps the account in the footer",
  async ({ app }) => {
    await app.page.setViewportSize({ width: 1280, height: 800 });
    await expect(app.page.getByTestId("account-button")).toBeVisible();
    // The workspace reports that it needs a sign-in; the renderer reconnects
    // from scratch after a reload.
    await overrideDesktopApi(app, { connectionFailure: "authentication" });
    await app.page.reload();
    const status = app.page.getByRole("button", {
      name: "Connection: Sign in required",
    });
    await expect(status).toBeVisible();
    await overrideDesktopApi(app, {});
    await status.click();
    const dialog = app.page.getByRole("dialog", { name: "Sign in required" });
    await dialog.getByRole("button", { name: "Sign in" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      app.page.getByRole("status", { name: "Connection: Connected" }),
    ).toBeVisible();
    await expect(app.page.getByTestId("account-button")).toHaveAccessibleName(
      "Account: e2e@example.com",
    );
  },
);
