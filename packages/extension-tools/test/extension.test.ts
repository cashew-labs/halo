import path from "node:path";
import { expect } from "@playwright/test";
import { extensionTest } from "./extensionTest.js";

const tasks = path.join(import.meta.dirname, "fixtures", "tasks");
const websocketGreeting = path.join(
  import.meta.dirname,
  "fixtures",
  "websocket-greeting",
);
const proxyView = path.join(import.meta.dirname, "fixtures", "proxy-view");

extensionTest(
  "serves API-backed views at nested URLs without Halo",
  async ({ loadExtension, page }) => {
    const extension = await loadExtension(tasks);
    await page.goto(`${extension.url}tasks/today`);
    await expect(
      page.getByRole("heading", { name: "Shared tasks" }),
    ).toBeVisible();
  },
);

extensionTest(
  "syncs task edits between independent browsers",
  async ({ loadExtension, page, browser }) => {
    const extension = await loadExtension(tasks);
    const collaborator = await browser.newContext();
    const other = await collaborator.newPage();
    await page.goto(extension.url);
    await other.goto(extension.url);
    await page
      .getByRole("textbox", { name: "New task" })
      .fill("Plan the launch");
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(other.getByText("Launch", { exact: true })).toBeVisible();
    await other.getByText("Plan the launch", { exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "Plan the launch" }),
    ).toBeChecked();
    await collaborator.close();
  },
);

extensionTest(
  "preserves tasks across a server restart",
  async ({ loadExtension, page, browser }) => {
    const extension = await loadExtension(tasks);
    const observer = await browser.newContext();
    const observed = await observer.newPage();
    await page.goto(extension.url);
    await observed.goto(extension.url);
    await page
      .getByRole("textbox", { name: "New task" })
      .fill("Keep this task");
    await page.getByRole("button", { name: "Add task" }).click();
    // A remote observation confirms the write reached the server before restarting it.
    await observed.getByRole("checkbox", { name: "Keep this task" }).waitFor();
    await observer.close();
    await page.close();
    await extension.restart();
    const fresh = await browser.newContext();
    const reopened = await fresh.newPage();
    await reopened.goto(extension.url);
    await expect(
      reopened.getByRole("checkbox", { name: "Keep this task" }),
    ).toBeVisible();
    await fresh.close();
  },
);

extensionTest(
  "serves an SDK WebSocket from the extension API",
  async ({ loadExtension, page }) => {
    const extension = await loadExtension(websocketGreeting);
    await page.goto(extension.url);
    await expect(page.getByRole("status")).toHaveText("Hello from WebSocket");
  },
);

extensionTest(
  "proxies a server-backed view across an extension restart",
  async ({ loadExtension, page }) => {
    const extension = await loadExtension(proxyView);
    await page.goto(extension.url);
    await expect(page.getByRole("status")).toHaveText("Hello from proxy view");

    await extension.restart();
    await page.reload();
    await expect(page.getByRole("status")).toHaveText("Hello from proxy view");
  },
);
