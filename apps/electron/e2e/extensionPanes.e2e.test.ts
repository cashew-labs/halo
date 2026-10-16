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
