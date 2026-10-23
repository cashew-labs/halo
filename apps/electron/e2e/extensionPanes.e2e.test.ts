import { expect } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";

e2eTest(
  "opens an interactive extension pane from the workspace sidebar",
  async ({ app, harness }) => {
    await harness.loadExtension("./fixtures/greeting");

    await app.page
      .getByRole("link", { name: "greeting", exact: true })
      .click({ timeout: 10_000 });

    const frame = app.page.locator('iframe[title="greeting"]');
    await expect(frame).toHaveAttribute(
      "src",
      /\/extensions\/greeting\/view\/$/,
    );

    const pane = frame.contentFrame();
    await pane.getByRole("textbox", { name: "Your name" }).fill("Ada");
    await pane.getByRole("button", { name: "Greet", exact: true }).click();
    await expect(pane.getByRole("status")).toHaveText("Hello, Ada!");

    // A private link must remain available without provisioning a hosted app,
    // including local workspaces that cannot load external sharing access.
    const share = app.page.getByRole("button", { name: "Share", exact: true });
    await share.click();
    const dialog = app.page.getByRole("dialog", { name: "Share greeting" });
    await dialog
      .getByRole("button", { name: "Copy link", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Copied", exact: true }),
    ).toBeVisible();
    const link = await app.electron.evaluate(
      async ({ clipboard }) => await clipboard.readText(),
    );
    expect(new URL(link).pathname).toBe("/extensions/greeting");
    expect(new URL(link).search).toBe("");
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(share).toBeFocused();
  },
);

// Durable: standalone URLs must not replace Electron's packaged document.
e2eTest(
  "keeps the desktop document when navigating standalone extension URLs",
  async ({ app, harness }) => {
    await harness.loadExtension("./fixtures/greeting");
    await harness.loadExtension("./fixtures/websocket-greeting");
    await app.page.evaluate(() => {
      document.documentElement.setAttribute("data-original-document", "true");
    });

    for (const [extensionId, name] of [
      ["greeting", "greeting"],
      ["websocket-greeting", "WebSocket Greeting"],
    ] as const) {
      await app.page.evaluate(
        (pathname) => window.history.pushState({}, "", pathname),
        `/extensions/${extensionId}`,
      );
      await expect(app.page.getByTitle(name, { exact: true })).toBeVisible();
      await expect(app.page.locator('link[rel="manifest"]')).toHaveCount(0);
      await expect(app.page.locator("html")).toHaveAttribute(
        "data-original-document",
        "true",
      );
    }

    await app.page.evaluate(() => window.history.pushState({}, "", "/"));
    await expect(app.page.getByTestId("threads-shell")).toBeVisible();
    await expect(app.page.locator("html")).toHaveAttribute(
      "data-original-document",
      "true",
    );
  },
);

e2eTest(
  "opens external extension links in the system browser and keeps internal links in the pane",
  async ({ app, harness }) => {
    await harness.loadExtension("./fixtures/links");
    await app.page
      .getByRole("link", { name: "links", exact: true })
      .click({ timeout: 10_000 });
    const pane = app.page.locator('iframe[title="links"]').contentFrame();
    await expect(pane.getByRole("status")).toHaveText("home");
    const externalUrls = await app.observeExternalUrls();

    await pane.getByRole("link", { name: "Plain link" }).click();
    await expect
      .poll(async () => await externalUrls.jsonValue())
      .toEqual(["https://example.com/plain"]);
    await expect(pane.getByRole("status")).toHaveText("home");
    await pane.getByRole("link", { name: "New tab link" }).click();
    await pane.getByRole("button", { name: "Open window" }).click();
    await expect
      .poll(async () => await externalUrls.jsonValue())
      .toEqual([
        "https://example.com/plain",
        "https://example.com/new-tab",
        "https://example.com/window-open",
      ]);
    await expect(pane.getByRole("status")).toHaveText("home");
    expect(app.page.context().pages()).toHaveLength(1);

    await pane.getByRole("link", { name: "Settings" }).click();
    await expect(pane.getByRole("status")).toHaveText("?page=settings");
    expect(await externalUrls.jsonValue()).toHaveLength(3);
  },
);
