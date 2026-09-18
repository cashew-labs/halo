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
  "opens an extension WebSocket from the workspace sidebar",
  async ({ app, harness }) => {
    await harness.loadExtension("./fixtures/websocket-greeting");

    await app.page
      .getByRole("link", { name: "WebSocket Greeting", exact: true })
      .click();

    const frame = app.page
      .getByTitle("WebSocket Greeting", { exact: true })
      .contentFrame();
    await expect(frame.getByRole("status")).toHaveText("Hello from WebSocket");
  },
);

e2eTest(
  "syncs tasks from a separate browser into an open Halo pane without losing its draft",
  async ({ app, harness }) => {
    e2eTest.setTimeout(240_000);
    const loaded = await harness.loadExtension(
      "../../../packages/extension-tools/test/fixtures/tasks",
    );
    await app.page.getByRole("link", { name: "tasks", exact: true }).click();
    const pane = app.page.locator('iframe[title="tasks"]').contentFrame();
    await pane.getByRole("textbox", { name: "New task" }).fill("My draft");

    const extensions = await app.server.rpc.extensions.list();
    const extension = extensions.find((entry) => entry.id === loaded.id)!;
    const browser = await app.server.rpc.browser.open({ url: extension.url });
    await app.server.rpc.browser.exec({
      id: browser.id,
      source: `
        await page.getByRole("textbox", { name: "New task" }).fill("From the agent");
        await page.getByRole("button", { name: "Add task" }).click();
      `,
    });

    await expect(
      pane.getByRole("checkbox", { name: "From the agent" }),
    ).toBeVisible();
    await expect(pane.getByRole("textbox", { name: "New task" })).toHaveValue(
      "My draft",
    );
  },
);

e2eTest(
  "removes a deleted extension from the sidebar and stops its server on reload",
  async ({ app, harness, request }) => {
    e2eTest.setTimeout(60_000);
    const loaded = await harness.loadExtension("./fixtures/greeting");
    const extension = (await app.server.rpc.extensions.list()).find(
      (entry) => entry.id === loaded.id,
    )!;
    await app.page.getByRole("link", { name: "greeting", exact: true }).click();

    await harness.tools.bash.run({
      command: "rm -rf .halo/extensions/greeting",
    });
    await app.server.rpc.extensions.reload();
    await app.page.reload();

    await expect(
      app.page.getByRole("link", { name: "greeting", exact: true }),
    ).toHaveCount(0);
    await expect(
      request.get(extension.url, { timeout: 5_000 }),
    ).rejects.toThrow(/ECONNREFUSED/);
  },
);

e2eTest(
  "updates an extension's name and icon on renderer reload without changing its URL",
  async ({ app, harness }) => {
    await harness.loadExtension("./fixtures/greeting");
    const [before] = await app.server.rpc.extensions.list();

    await harness.tools.bash.run({
      command:
        'cd .halo/extensions/greeting && npm pkg set halo.displayName="Welcome" halo.icon="Calendar"',
    });
    await app.page.reload();
    const entry = app.page.getByRole("link", {
      name: "Welcome",
      exact: true,
    });
    const icon = entry.locator("..").locator("svg");
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute("aria-hidden", "true");
    await entry.click();
    await expect(
      app.page.getByRole("main", { name: "Welcome", exact: true }),
    ).toBeVisible();
    const [after] = await app.server.rpc.extensions.list();
    expect(after?.url).toBe(before?.url);
  },
);
