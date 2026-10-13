import { expect } from "@playwright/test";
import { e2eTest } from "../e2eTest.js";
import { m } from "@get-halo/shared/testing";
import path from "node:path";

const screenshots = path.resolve(
  import.meta.dirname,
  "../../../../.context/tool-activity",
);

e2eTest(
  "keeps parallel and rapid tool calls in the collapsed summary",
  async ({ app, harness, llm }) => {
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    await app.page
      .getByRole("main", { name: "New session", exact: true })
      .getByLabel("Message", { exact: true })
      .fill("Inspect the workspace with parallel commands.");
    await app.page
      .getByRole("main", { name: "New session", exact: true })
      .getByRole("button", { name: "Send", exact: true })
      .click();
    await expect(app.page.getByText("Working", { exact: true })).toBeVisible();
    await llm.respond(
      m.tool.start("exec", {
        id: "parallel-commands",
        arguments: {
          js: 'await Promise.all([tools.bash.run({command: "while [ ! -f release-first ]; do sleep 0.1; done; pwd"}), tools.bash.run({command: "while [ ! -f release-tools ]; do sleep 0.1; done; ls"})]);',
        },
      }),
    );
    const activity = app.page.getByLabel("Tool activity", { exact: true });
    const summary = activity.getByRole("button").first();
    const activeLabel =
      "$ while [ ! -f release-tools ]; do sleep 0.1; done; ls";
    await expect(summary).toHaveText(`${activeLabel} (+1 more)`);
    await expect(summary).toHaveAttribute(
      "aria-label",
      `${activeLabel} (+1 more)`,
    );
    await expect(summary).toHaveAttribute("title", `${activeLabel} (+1 more)`);
    await expect(activity.getByRole("button")).toHaveCount(1);
    await expect(
      app.page.getByLabel("Active tools", { exact: true }),
    ).toHaveCount(0);
    await app.page.setViewportSize({ width: 1280, height: 800 });
    await app.page.screenshot({
      path: path.join(screenshots, "active-desktop-1280x800.png"),
    });
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.page.screenshot({
      path: path.join(screenshots, "active-mobile-390x844.png"),
    });
    await summary.click();
    await expect(activity.getByRole("button")).toHaveCount(3);
    await summary.click();
    await harness.tools.files.write({ path: "release-first", content: "go" });
    await expect(summary).toHaveText(activeLabel);
    await expect(summary).toHaveAttribute("aria-label", activeLabel);
    await expect(summary).toHaveAttribute("title", activeLabel);
    await harness.tools.files.write({ path: "release-tools", content: "go" });
    await expect(summary).toHaveText("Ran 2 commands");
    for (let index = 0; index < 3; index += 1) {
      await llm.respond(
        m.tool.start("read", {
          id: `rapid-read-${index}`,
          arguments: { path: "release-tools" },
        }),
      );
      await expect(summary).toHaveText("Ran 2 commands and read 1 file");
      await expect(activity.getByRole("button")).toHaveCount(1);
    }
    await llm.respond(
      m.assistant("Finished the parallel commands and file reads."),
    );
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).not.toBeVisible();
    await expect(summary).toHaveText("Ran 2 commands and read 1 file");
    await summary.click();
    await expect(
      activity.getByRole("button", {
        name: "Read release-tools (read)",
        exact: true,
      }),
    ).toHaveCount(3);
  },
);
