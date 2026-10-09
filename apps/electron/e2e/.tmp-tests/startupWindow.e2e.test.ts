import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import * as errore from "errore";
import { e2eTest } from "../e2eTest.js";

process.env.HALO_E2E_HEADFUL = "1";

e2eTest(
  "keeps startup chrome until the workspace mounts and restores it for standalone views",
  async ({ app, testArtifacts, harness }, testInfo) => {
    const page = app.page;
    await expect.poll(() => app.isWindowVisible()).toBe(true);
    const assertStartupLayout = async () => {
      const strip = page.locator("#startup-titlebar");
      await expect(strip).toHaveCSS("-webkit-app-region", "drag");
      await expect(strip).toHaveCSS("height", "36px");
      expect(
        await page.evaluate(
          () => document.scrollingElement!.scrollHeight <= innerHeight,
        ),
      ).toBe(true);
    };
    const discovery = path.join(testArtifacts.paths.userData, "server.json");
    const held = `${discovery}.held`;
    await fs.rename(discovery, held);
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      if (
        await fs.stat(held).then(
          () => true,
          () => false,
        )
      )
        await fs.rename(held, discovery);
    });

    await page.reload();
    await expect(
      page.getByText(
        "Waiting for your server. Halo will connect automatically.",
      ),
    ).toBeVisible();
    await expect(page.locator("#startup-titlebar")).toBeVisible();
    await expect(page.getByTestId("sessions-shell")).toHaveCount(0);
    await assertStartupLayout();
    const waiting = await page
      .getByText("Waiting for your server. Halo will connect automatically.")
      .boundingBox();
    expect(waiting!.y).toBeGreaterThanOrEqual(36);
    await page.screenshot({
      path: testInfo.outputPath("waiting-for-server.png"),
    });

    await fs.rename(held, discovery);
    await expect(page.getByTestId("sessions-shell")).toBeVisible();
    await expect(page.locator("#startup-titlebar")).toBeHidden();
    const shell = await page.locator("[data-window-shell]").boundingBox();
    expect(shell!.y).toBe(0);
    expect(shell!.height).toBe(await page.evaluate(() => innerHeight));
    const tabs = page.getByRole("button", {
      name: "Close New session",
      exact: true,
    });
    const count = await tabs.count();
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await expect(tabs).toHaveCount(count + 1);
    await page.screenshot({
      path: testInfo.outputPath("workspace-handoff.png"),
    });

    const extension = await harness.loadExtension("../fixtures/greeting");
    await page.evaluate(
      (id) => history.pushState({}, "", `/extensions/${id}`),
      extension.id,
    );
    await expect(page.getByTestId("sessions-shell")).toHaveCount(0);
    await expect(page.locator("#startup-titlebar")).toBeVisible();
    await assertStartupLayout();
    const frame = await page.locator('iframe[title="greeting"]').boundingBox();
    expect(frame!.y).toBeGreaterThanOrEqual(36);
    const view = page.frameLocator('iframe[title="greeting"]');
    await view.getByRole("textbox", { name: "Your name" }).fill("Ada");
    await view.getByRole("button", { name: "Greet", exact: true }).click();
    await expect(view.getByText("Hello, Ada!")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("standalone-extension.png"),
    });

    await page.evaluate(() => history.pushState({}, "", "/"));
    await expect(page.getByTestId("sessions-shell")).toBeVisible();
    await expect(page.locator("#startup-titlebar")).toBeHidden();
  },
);
