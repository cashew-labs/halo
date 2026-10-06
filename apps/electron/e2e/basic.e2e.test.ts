import { expect } from "@playwright/test";
import { m } from "@get-halo/shared/testing";
import { haloProtocolVersion } from "@get-halo/client";
import type { DesktopBridge } from "../src/shared/desktop.js";
import { e2eTest } from "./e2eTest.js";

e2eTest("opens the server-configured workspace", async ({ harness, app }) => {
  await expect(
    app.page.getByRole("main", { name: "New session" }),
  ).toBeVisible();
  await expect(
    app.page.getByRole("button", { name: "New tab", exact: true }),
  ).toBeVisible();
  await expect(
    app.page.getByTestId("app-update-status").getByText(/^\d+\.\d+\.\d+$/),
  ).toBeVisible();

  expect(await app.server.rpc.workspace.get()).toMatchObject({
    workspaceRoot: harness.paths.workspace,
  });
});

e2eTest("rejects a non-web external URL", async ({ app }) => {
  await expect(
    app.page.evaluate(async () => {
      // SAFETY: Halo's preload exposes DesktopBridge as window.haloDesktop.
      const desktopBridge = (
        window as typeof window & { haloDesktop: DesktopBridge }
      ).haloDesktop;
      await desktopBridge.openExternal({
        url: "file:///tmp/halo-external-url-test",
      });
    }),
  ).rejects.toThrow("file: URLs are not supported");
});

e2eTest(
  "keeps an edited workspace note after quitting and reopening",
  async ({ app, harness }) => {
    await app.server.rpc.workspace.writeFile({
      path: "notes.md",
      content: "# Original",
    });

    await app.page.getByRole("link", { name: "notes.md" }).click();
    const filePane = app.page.getByRole("main", { name: "notes.md" });
    const editor = filePane.getByLabel("notes.md", { exact: true });
    await expect(editor).toHaveText("Original");
    await editor.fill("Edited in Halo");

    await expect
      .poll(
        async () =>
          await app.server.rpc.workspace.readFile({ path: "notes.md" }),
      )
      .toContain("Edited in Halo");

    const server = app.server.rpc;
    await app.quit();
    expect(await server.workspace.readFile({ path: "notes.md" })).toContain(
      "Edited in Halo",
    );
    await app.open();

    await app.page.getByRole("link", { name: "notes.md" }).click();
    await expect(
      app.page
        .getByRole("main", { name: "notes.md" })
        .getByLabel("notes.md", { exact: true }),
    ).toHaveText("Edited in Halo");
    expect(await app.server.rpc.workspace.get()).toMatchObject({
      workspaceRoot: harness.paths.workspace,
    });
    expect(await harness.tools.files.read({ path: "notes.md" })).toMatchObject({
      text: expect.stringContaining("Edited in Halo"),
    });
  },
);

e2eTest(
  "restores open tabs, selection, and closed tabs after refresh and restart",
  async ({ app }) => {
    const page = app.page;
    for (const name of ["One", "Two", "Three"]) {
      await app.server.rpc.workspace.writeFile({
        path: `${name}.md`,
        content: `# ${name}`,
      });
      await page
        .getByRole("link", { name: `${name}.md`, exact: true })
        .click({ modifiers: ["Meta"] });
    }
    await page
      .getByRole("toolbar", { name: /^Pane \d+ tabs$/ })
      .getByRole("button", { name: "Two.md", exact: true })
      .click();
    await page.reload();
    await expect(
      page.locator("[role=toolbar] button[aria-pressed]"),
    ).toHaveText(["New session", "One.md", "Two.md", "Three.md"]);
    await expect(
      page
        .getByRole("toolbar", { name: /^Pane \d+ tabs$/ })
        .getByRole("button", { name: "Two.md", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("main", { name: "Two.md", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close Two.md", exact: true })
      .click();
    await page.reload();
    await expect(
      page.locator("[role=toolbar] button[aria-pressed]"),
    ).toHaveText(["New session", "One.md", "Three.md"]);
    await expect(
      page
        .getByRole("toolbar", { name: /^Pane \d+ tabs$/ })
        .getByRole("button", { name: "Three.md", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await app.quit();
    await app.open();
    await expect(
      app.page.locator("[role=toolbar] button[aria-pressed]"),
    ).toHaveText(["New session", "One.md", "Three.md"]);
    await expect(
      app.page
        .getByRole("toolbar", { name: /^Pane \d+ tabs$/ })
        .getByRole("button", { name: "Three.md", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    // A full navigation loads the URL before the pane manager starts.
    await app.page.evaluate(() =>
      window.history.replaceState(undefined, "", "#/files/Two.md"),
    );
    await app.page.reload();
    await expect(
      app.page.locator("[role=toolbar] button[aria-pressed]"),
    ).toHaveText(["New session", "One.md", "Three.md", "Two.md"]);
    await expect(
      app.page
        .getByRole("toolbar", { name: /^Pane \d+ tabs$/ })
        .getByRole("button", { name: "Two.md", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await app.page.evaluate(() =>
      window.history.replaceState(undefined, "", "#/files/One.md"),
    );
    await app.page.reload();
    await expect(
      app.page.locator("[role=toolbar] button[aria-pressed]"),
    ).toHaveCount(4);
    await expect(
      app.page
        .getByRole("toolbar", { name: /^Pane \d+ tabs$/ })
        .getByRole("button", { name: "One.md", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  },
);

e2eTest(
  "Tiptap edits Markdown delimiters with undo and persists rich formatting",
  async ({ app }) => {
    const path = "tiptap.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content: "## Heading\n\nBefore **bold** after.\n\nPlain paragraph.",
    });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByTestId("file-page-content").locator(".tiptap");
    await editor.locator("strong").click();
    const source = editor.getByRole("textbox", {
      name: "Markdown syntax",
      exact: true,
    });
    await expect(source).toHaveText("**bold**");
    await source.fill("*bold*");
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toContain("Before *bold* after.");
    await source.press("ControlOrMeta+z");
    await expect(source).toHaveText("**bold**");
    await source.press("ControlOrMeta+Shift+z");
    await expect(source).toHaveText("*bold*");
    await source.fill("bold");
    await editor.getByText("Plain paragraph.", { exact: true }).click();
    await expect(editor.locator("strong, em")).toHaveCount(0);
    await editor.getByRole("heading").click();
    await expect(source).toHaveText("## Heading");
    await source.fill("Heading");
    await editor.getByText("Plain paragraph.", { exact: true }).click();
    await expect(editor.getByRole("heading")).toHaveCount(0);
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toBe("Heading\n\nBefore bold after.\n\nPlain paragraph.");
    await app.page.reload();
    await expect(editor).toContainText("Heading");
    await expect(editor.locator("strong, em, h1, h2")).toHaveCount(0);
  },
);

e2eTest(
  "recovers after returning online without losing the draft",
  async ({ app }) => {
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Connected",
        exact: true,
      }),
    ).toBeVisible();
    const input = app.page
      .locator('[data-testid="pane-tab-content"]:visible')
      .getByLabel("Message", { exact: true });
    await input.fill("Keep this while I leave the office");
    await app.page.clock.install();
    await app.page.context().setOffline(true);
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Disconnected",
        exact: true,
      }),
    ).toBeVisible();
    await app.page.clock.fastForward(60 * 60 * 1000);
    await expect(input).toHaveText("Keep this while I leave the office");
    await app.page.context().setOffline(false);
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Connected",
        exact: true,
      }),
    ).toBeVisible();
    await expect(input).toHaveText("Keep this while I leave the office");
    await expect(
      app.page.getByText("Halo disconnected from its server", { exact: true }),
    ).toHaveCount(0);
    expect(await app.server.rpc.thread.list()).toHaveLength(0);
  },
);

e2eTest(
  "accepts an explicitly supported protocol and reports an older server",
  async ({ app }) => {
    await app.page.route("**/rpc/server/info", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          json: {
            protocolVersion: haloProtocolVersion - 1,
            supportedProtocols: [haloProtocolVersion - 1, haloProtocolVersion],
          },
        }),
      });
    });
    await app.page.reload();
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Connected",
        exact: true,
      }),
    ).toBeVisible();
    await app.page.unroute("**/rpc/server/info");
    await app.page.route("**/rpc/server/info", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          json: {
            protocolVersion: haloProtocolVersion - 1,
            supportedProtocols: [haloProtocolVersion - 1],
          },
        }),
      });
    });
    await app.page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(
      app.page.getByRole("button", {
        name: "Connection: Server update required",
        exact: true,
      }),
    ).toBeVisible();
    await app.page.unroute("**/rpc/server/info");
    await app.page
      .getByRole("button", {
        name: "Connection: Server update required",
        exact: true,
      })
      .click();
    await app.page
      .getByRole("button", { name: "Retry now", exact: true })
      .click();
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Connected",
        exact: true,
      }),
    ).toBeVisible();
  },
);

e2eTest(
  "automatically merges an offline note after reconnecting without a conflict dialog",
  async ({ app, llm }) => {
    await app.server.rpc.workspace.writeFile({
      path: "offline.md",
      content: "Original",
    });
    await app.page
      .getByRole("link", { name: "offline.md", exact: true })
      .click();
    const editor = app.page
      .getByRole("main", { name: "offline.md" })
      .getByLabel("offline.md", { exact: true });
    await expect(editor).toHaveText("Original");
    await app.page.context().setOffline(true);
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Disconnected",
        exact: true,
      }),
    ).toBeVisible();
    await app.page.clock.install();
    await app.page.clock.pauseAt(new Date());
    await editor.fill("My unsaved edit");
    await app.page.clock.runFor(500);
    await expect(
      app.page.getByRole("main", { name: "offline.md" }).getByRole("status"),
    ).toHaveCount(0);
    await expect(
      app.page.getByRole("button", { name: "Save error", exact: true }),
    ).toHaveCount(0);
    await expect(
      app.page.getByRole("button", { name: "Retry save", exact: true }),
    ).toHaveCount(0);
    await app.page.clock.resume();
    await app.server.rpc.workspace.writeFile({
      path: "offline.md",
      content: "Changed elsewhere",
    });
    await app.page.context().setOffline(false);
    await llm.respond(
      m.assistant(
        JSON.stringify({
          markdown: "My unsaved edit and the detail changed elsewhere.",
        }),
      ),
    );
    await expect(editor).toHaveText(
      "My unsaved edit and the detail changed elsewhere.",
    );
    await expect
      .poll(
        async () =>
          await app.server.rpc.workspace.readFile({ path: "offline.md" }),
      )
      .toBe("My unsaved edit and the detail changed elsewhere.");
    await expect(
      app.page.getByText(/This file changed on the server/),
    ).toHaveCount(0);
    await expect(
      app.page.getByRole("button", { name: "Save error", exact: true }),
    ).toHaveCount(0);
  },
);
