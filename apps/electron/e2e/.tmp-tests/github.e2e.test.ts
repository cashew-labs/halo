import { expect } from "@playwright/test";
import { e2eTest } from "../e2eTest.js";
import { m } from "@get-halo/shared/testing";
import path from "node:path";

e2eTest("shows the GitHub connection card", async ({ app, harness }) => {
  const root = path.resolve(import.meta.dirname, "../../../..");
  await app.page.route(
    "https://gethalo.dev/logos/github.svg",
    async (route) => {
      await route.fulfill({
        path: path.join(root, "apps/web-app/public/logos/github.svg"),
        contentType: "image/svg+xml",
      });
    },
  );
  await harness.loadSession({
    title: "GitHub integration",
    messages: [
      m.user("Connect GitHub"),
      m.assistant(
        "Connect GitHub to work with repositories, issues, and pull requests.",
      ),
      m.connectionRequest({ kind: "control-plane", integration: "github" }),
    ],
  });
  const card = app.page.getByRole("region", {
    name: "GitHub connection",
    exact: true,
  });
  await expect(card).toBeVisible();
  await expect(
    card.getByText(
      "Work with repositories, issues, pull requests, and actions.",
    ),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Connect", exact: true }),
  ).toBeEnabled();
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await app.page.setViewportSize(viewport);
    await app.page.screenshot({
      path: path.join(
        root,
        `.context/github-card-${viewport.width}x${viewport.height}.png`,
      ),
    });
  }
});
