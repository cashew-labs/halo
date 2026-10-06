import { expect } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";

e2eTest(
  "reads workspace notes through a trusted extension tool",
  async ({ app, harness }) => {
    await harness.loadExtension("./fixtures/workspaceNotes");
    await app.page
      .getByRole("link", { name: "workspaceNotes", exact: true })
      .click();
    const pane = app.page
      .locator('iframe[title="workspaceNotes"]')
      .contentFrame();

    await harness.tools.files.write({
      path: "notes.txt",
      content: "Discuss the extension tool bridge on Friday.",
    });
    await pane.getByRole("button", { name: "Refresh notes" }).click();

    await expect(pane.getByRole("status")).toHaveText(
      "Discuss the extension tool bridge on Friday.",
    );
  },
);
