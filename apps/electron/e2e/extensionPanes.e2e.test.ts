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
