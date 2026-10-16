import path from "node:path";
import { expect } from "@playwright/test";
import { e2eTest } from "../e2eTest.js";
import { routeWorkspaceRpc } from "../workspaceSocket.js";

e2eTest(
  "deleting apps show a retry instruction without sharing controls",
  async ({ app }) => {
    const appId = "da65d61e-541d-4168-9ef8-c5b9db4aa30d";
    await app.server.rpc.extensions.addRemote({
      id: "delete-me",
      appId,
      displayName: "Delete me",
      url: "https://example.test/delete-me/view/",
    });
    await routeWorkspaceRpc(app.page, (request) => {
      if (request.path === "/apps/list") {
        request.fulfill({
          json: [
            {
              appId,
              extensionId: "delete-me",
              displayName: "Delete me",
              handle: "owner",
              slug: "delete-me",
              url: "https://example.test/delete-me/",
              published: false,
              stage: "deleting",
              visibility: "public",
              members: [],
              actions: [],
            },
          ],
        });
        return;
      }
      request.continue();
    });
    await app.page.reload();
    await app.page
      .getByRole("link", { name: "Delete me", exact: true })
      .click();
    await app.page.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = app.page.getByRole("dialog", { name: "Share app" });
    await expect(dialog.getByRole("status")).toHaveText(
      `Deletion has started. Run halo app delete ${appId} to finish removing this app and its data.`,
    );
    await expect(
      dialog.getByRole("button", { name: /Publish|Share again|Keep it local/ }),
    ).toHaveCount(0);
    const context = path.resolve(import.meta.dirname, "../../../../.context");
    await app.page.setViewportSize({ width: 1280, height: 900 });
    await app.page.screenshot({
      path: path.join(context, "app-deleting-desktop-1280x900.png"),
    });
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.page.screenshot({
      path: path.join(context, "app-deleting-mobile-390x844.png"),
    });
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  },
);
