import { expect } from "@playwright/test";
import { extensionTest } from "../extensionTest.js";
import fs from "node:fs/promises";
import path from "node:path";
import * as errore from "errore";

extensionTest(
  "measures extension loading and assets",
  async ({ loadExtension, page }) => {
    const extension = await loadExtension(
      path.resolve(import.meta.dirname, "../fixtures/tasks"),
    );
    const requests: string[] = [];
    page.on("request", (request) => {
      requests.push(new URL(request.url()).pathname);
    });
    await page.route("**/sync/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.continue();
    });
    const start = performance.now();
    await page.goto(extension.url);
    await expect(
      page.getByRole("heading", { name: "Shared tasks" }),
    ).toBeVisible();
    const shell = performance.now() - start;
    await page.getByRole("textbox", { name: "New task" }).fill("Saved task");
    const pushed = page.waitForResponse(
      (response) => response.url().endsWith("/sync/push") && response.ok(),
    );
    await page.getByRole("button", { name: "Add task" }).click();
    await pushed;
    await expect(
      page.getByRole("checkbox", { name: "Saved task" }),
    ).toBeVisible();
    // A second load measures real synchronized content, not just the shell.
    const pullsBeforeReload = requests.filter((request) =>
      request.endsWith("/sync/pull"),
    ).length;
    const reload = performance.now();
    await page.reload();
    await expect(
      page.getByRole("checkbox", { name: "Saved task" }),
    ).toBeVisible();
    const content = performance.now() - reload;
    expect(
      requests.filter((request) => request.endsWith("/sync/pull")).length -
        pullsBeforeReload,
    ).toBe(1);
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.screenshot({
        path: path.resolve(
          `../../.context/extension-${viewport.width}x${viewport.height}.png`,
        ),
      });
    }
    const asset = await page.request.get(
      new URL("assets/view.js", extension.url).href,
    );
    const text = await asset.text();
    const results = {
      shell,
      content,
      scriptBytes: Buffer.byteLength(text),
      developmentReact: text.includes("react.development.js"),
      requests,
    };
    expect(results.developmentReact).toBe(false);
    expect(results.scriptBytes).toBeLessThan(1_000_000);
    await fs.mkdir(path.resolve("../../tmp/loading-speed"), {
      recursive: true,
    });
    await fs.writeFile(
      path.resolve(
        `../../tmp/loading-speed/extensions-${process.env.LOADING_RUN ?? "baseline"}.json`,
      ),
      JSON.stringify(results, undefined, 2),
    );
    console.log("EXTENSION_TIMINGS", JSON.stringify(results));
  },
);

extensionTest(
  "shows the API-backed interface while sync is unavailable",
  async ({ loadExtension, page }) => {
    const extension = await loadExtension(
      path.resolve(import.meta.dirname, "../fixtures/tasks"),
    );
    await page.route(
      "**/sync/connect",
      async (route) =>
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            json: {
              defined: false,
              code: "FORBIDDEN",
              inferable: false,
              message: "Forbidden",
            },
          }),
        }),
    );
    await page.goto(extension.url);
    await expect(
      page.getByRole("heading", { name: "Shared tasks" }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "New task" })).toBeVisible();
  },
);

extensionTest(
  "shows a reload action after sync failure and recovers",
  async ({ loadExtension, page }) => {
    const extension = await loadExtension(
      path.resolve(import.meta.dirname, "../fixtures/tasks"),
    );
    await page.route(
      "**/sync/connect",
      async (route) => await route.fulfill({ status: 503 }),
    );
    await page.goto(extension.url);
    await expect(page.getByRole("alert")).toContainText(
      "Couldn't load this app's data",
    );
    await expect(page.getByRole("textbox", { name: "New task" })).toHaveCount(
      0,
    );
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.screenshot({
        path: path.resolve(
          `../../.context/extension-error-${viewport.width}x${viewport.height}.png`,
        ),
      });
    }
    await page.unrouteAll();
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Shared tasks" }),
    ).toBeVisible();
  },
);

extensionTest(
  "renders and saves an early edit before the sync connection is ready",
  async ({ loadExtension, page }) => {
    const extension = await loadExtension(
      path.resolve(import.meta.dirname, "../fixtures/tasks"),
    );
    await page.clock.install();
    const pending = Promise.withResolvers<void>();
    using cleanup = new errore.DisposableStack();
    cleanup.defer(pending.resolve);
    await page.route("**/sync/connect", async (route) => {
      await pending.promise;
      await route.continue();
    });
    await page.goto(extension.url, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Shared tasks" }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "New task" })).toBeVisible();
    const pushed = page.waitForResponse(
      (response) => response.url().endsWith("/sync/push") && response.ok(),
    );
    await page.getByRole("textbox", { name: "New task" }).fill("Early task");
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(
      page.getByRole("checkbox", { name: "Early task" }),
    ).toBeVisible();
    // Drain the initial queue while connect is still held, then release it.
    await page.clock.fastForward(300);
    pending.resolve();
    await pushed;
    await page.unrouteAll({ behavior: "wait" });
    await page.reload();
    await expect(
      page.getByRole("checkbox", { name: "Early task" }),
    ).toBeVisible();
  },
);
