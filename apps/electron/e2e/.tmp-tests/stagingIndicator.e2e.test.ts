import fs from "node:fs/promises";
import nodePath from "node:path";
import { expect } from "@playwright/test";
import { e2eTest } from "../e2eTest.js";

const screenshots = nodePath.resolve(import.meta.dirname, "../../../../tmp/staging-indicator");

e2eTest("the sidebar footer shows no staging label on production", async ({ app }) => {
  await expect(app.page.getByTestId("app-update-status").getByText(/^\d+\.\d+\.\d+$/)).toBeVisible();
  await expect(app.page.getByTestId("app-release-channel")).toHaveCount(0);
  await fs.mkdir(screenshots, { recursive: true });
  await app.page.setViewportSize({ width: 1280, height: 800 });
  await app.page.screenshot({ path: nodePath.join(screenshots, "production-desktop-1280x800.png") });
});

e2eTest("the sidebar footer labels a staging install next to the version", async ({ app, testArtifacts }) => {
  await fs.writeFile(nodePath.join(testArtifacts.paths.userData, "release-channel"), "staging\n");
  await app.quit();
  await app.open();
  const label = app.page.getByTestId("app-release-channel");
  await expect(label).toHaveText("Staging");
  await expect(app.page.getByTestId("app-update-status").getByText(/^\d+\.\d+\.\d+$/)).toBeVisible();
  await fs.mkdir(screenshots, { recursive: true });
  await app.page.setViewportSize({ width: 1280, height: 800 });
  await app.page.screenshot({ path: nodePath.join(screenshots, "staging-desktop-1280x800.png") });
  const footer = app.page.getByTestId("app-update-status");
  await footer.screenshot({ path: nodePath.join(screenshots, "staging-footer-closeup.png") });
  await app.page.setViewportSize({ width: 390, height: 844 });
  // At phone width the sidebar opens as a drawer from the header's menu button.
  await app.page.mouse.click(26, 20);
  const drawer = app.page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(drawer.getByTestId("app-release-channel")).toHaveText("Staging");
  // Let the drawer finish sliding in before capturing it.
  await expect(drawer.getByTestId("app-release-channel")).toBeInViewport({ ratio: 1 });
  await app.page.waitForTimeout(500);
  await app.page.screenshot({ path: nodePath.join(screenshots, "staging-mobile-390x844.png") });
});
