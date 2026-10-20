import { routeWorkspaceRpc } from "./workspaceSocket.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { expect, type Locator } from "@playwright/test";
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
  await app.page.getByTestId("account-button").click();
  await expect(
    app.page
      .getByRole("dialog", { name: "Account" })
      .getByTestId("app-version"),
  ).toHaveText(/^Version \d+\.\d+\.\d+$/);

  expect(await app.server.rpc.workspace.get()).toMatchObject({
    workspaceRoot: harness.paths.workspace,
  });
});

e2eTest(
  "loads only expanded folders and refreshes them after reconnect",
  async ({ app }) => {
    const scopes: string[][] = [];
    const fullTreeReads: string[] = [];
    await routeWorkspaceRpc(app.page, (request) => {
      if (request.path === "/workspace/listPaths")
        fullTreeReads.push(request.path);
      if (request.path === "/workspace/watchDirectories") {
        const body = Value.Parse(
          Type.Object({
            json: Type.Object({ paths: Type.Array(Type.String()) }),
          }),
          request.body,
        );
        scopes.push(body.json.paths);
      }
      request.continue();
    });
    await app.server.rpc.workspace.writeFile({
      path: "Open/Nested/deep.md",
      content: "Deep note",
    });
    await app.server.rpc.workspace.writeFile({
      path: "Closed/Other/hidden.md",
      content: "Unopened",
    });
    await app.page.reload();
    await expect(
      app.page.getByRole("button", { name: "Expand Open", exact: true }),
    ).toBeVisible();
    await expect.poll(() => scopes.at(-1)).toEqual([""]);
    await app.page
      .getByRole("button", { name: "Expand Open", exact: true })
      .click();
    await expect(
      app.page.getByRole("button", { name: "Expand Nested", exact: true }),
    ).toBeVisible();
    await expect.poll(() => scopes.at(-1)).toEqual(["", "Open"]);
    await app.page
      .getByRole("button", { name: "Expand Nested", exact: true })
      .click();
    await expect(
      app.page.getByRole("link", { name: "deep.md", exact: true }),
    ).toBeVisible();
    await expect.poll(() => scopes.at(-1)).toEqual(["", "Open", "Open/Nested"]);
    const subscriptions = scopes.length;
    await app.server.rpc.workspace.writeFile({
      path: "Open/added.md",
      content: "A listing update without a scope change",
    });
    await expect(
      app.page.getByRole("link", { name: "added.md", exact: true }),
    ).toBeVisible();
    await app.server.rpc.workspace.deleteEntry({ path: "Open/added.md" });
    await expect(
      app.page.getByRole("link", { name: "added.md", exact: true }),
    ).toHaveCount(0);
    expect(scopes).toHaveLength(subscriptions);
    await app.page.getByRole("link", { name: "deep.md", exact: true }).click();
    await app.page
      .getByRole("button", { name: "Collapse Open", exact: true })
      .click();
    await expect.poll(() => scopes.at(-1)).toEqual([""]);
    await expect(
      app.page.getByRole("main", { name: "Open/Nested/deep.md", exact: true }),
    ).toContainText("Deep note");
    await app.server.rpc.workspace.writeFile({
      path: "Open/new.md",
      content: "Added while collapsed",
    });
    await app.page
      .getByRole("button", { name: "Expand Open", exact: true })
      .click();
    await expect(
      app.page.getByRole("link", { name: "new.md", exact: true }),
    ).toBeVisible();
    await app.page.context().setOffline(true);
    await app.server.rpc.workspace.writeFile({
      path: "Open/offline.md",
      content: "Added while offline",
    });
    await app.page.context().setOffline(false);
    await app.page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(
      app.page.getByRole("link", { name: "offline.md", exact: true }),
    ).toBeVisible();
    expect(fullTreeReads).toEqual([]);
    expect(scopes.flat().some((path) => path.startsWith("Closed"))).toBe(false);
    const actions = app.page.getByRole("button", {
      name: "Actions for deep.md",
      exact: true,
      includeHidden: true,
    });
    await app.page.getByRole("row").filter({ has: actions }).hover();
    await actions.click();
    await app.page
      .getByRole("menuitem", { name: "Move to…", exact: true })
      .click();
    await app.page.getByRole("button", { name: /Move to$/ }).click();
    await app.page.getByRole("option", { name: "Closed", exact: true }).click();
    await app.page.getByRole("button", { name: /Move to$/ }).click();
    await app.page
      .getByRole("option", { name: "Closed/Other", exact: true })
      .click();
    await app.page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(
      app.page.getByRole("main", { name: "Closed/Other/deep.md", exact: true }),
    ).toContainText("Deep note");
    await app.page
      .getByRole("link", { name: "offline.md", exact: true })
      .dblclick();
    const name = app.page.getByRole("textbox", {
      name: "Rename offline.md",
      exact: true,
    });
    await expect(name).toBeFocused();
    await name.press("ArrowUp");
    await expect(name).toBeFocused();
    await name.fill("renamed.md");
    await name.press("Enter");
    await expect(
      app.page.getByRole("link", { name: "renamed.md", exact: true }),
    ).toBeVisible();
    expect(
      await app.server.rpc.workspace.readFile({ path: "Open/renamed.md" }),
    ).toBe("Added while offline");
    await app.page
      .getByRole("link", { name: "renamed.md", exact: true })
      .dblclick();
    await expect(
      app.page.getByRole("textbox", { name: "Rename renamed.md" }),
    ).toBeFocused();
    await app.server.rpc.workspace.deleteEntry({ path: "Open/renamed.md" });
    await expect(
      app.page.getByRole("button", { name: "New file", exact: true }),
    ).toBeEnabled();
  },
);

e2eTest(
  "adds file and session links with @ in Markdown",
  async ({ app, harness }, testInfo) => {
    const previous = await harness.loadSession({
      title: "Previous plan",
      messages: [m.user("Plan the launch"), m.assistant("Launch on Friday.")],
    });
    await app.server.rpc.workspace.writeFile({
      path: "brief.md",
      content: "# Brief",
    });
    await app.server.rpc.workspace.writeFile({ path: "notes.md", content: "" });
    await app.page.getByRole("link", { name: "notes.md", exact: true }).click();
    const pane = app.page.getByRole("main", { name: "notes.md" });
    const editor = pane.getByLabel("notes.md", { exact: true });
    await editor.fill("See @brief");
    await app.page.screenshot({
      path: testInfo.outputPath("markdown-reference-picker.png"),
    });
    await pane.getByRole("option", { name: /brief.md/ }).click();
    await editor.pressSequentially("and @Previous");
    await pane.getByRole("option", { name: /Previous plan/ }).click();
    await expect
      .poll(
        async () =>
          await app.server.rpc.workspace.readFile({ path: "notes.md" }),
      )
      .toContain("/files/brief.md");
    const saved = await app.server.rpc.workspace.readFile({ path: "notes.md" });
    expect(saved).toContain(`/sessions/${previous.sessionId}`);
    await app.page.reload();
    await expect(pane.getByRole("link", { name: "@brief.md" })).toBeVisible();
    await pane
      .getByRole("link", { name: "@Previous plan" })
      .click({ modifiers: ["Meta"] });
    await expect(
      app.page.getByRole("main", { name: "Previous plan" }),
    ).toBeVisible();
  },
);

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

for (const level of [1, 2, 4]) {
  e2eTest(
    `formats the first level ${level} heading typed into a new Markdown file`,
    async ({ app }) => {
      const path = "new-heading.md";
      const prefix = "#".repeat(level);
      await app.page
        .getByRole("button", { name: "New file", exact: true })
        .click();
      const filename = app.page.getByRole("textbox", {
        name: "New file name",
      });
      await filename.fill(path);
      await filename.press("Enter");
      const editor = app.page
        .getByRole("main", { name: path, exact: true })
        .getByLabel(path, { exact: true });
      await expect(editor).toBeEmpty();
      await editor.click();
      await app.page.keyboard.type(prefix, { delay: 50 });
      await expect(editor).toHaveText(prefix);
      await app.page.keyboard.type(" ");
      const syntax = editor.getByRole("textbox", {
        name: "Markdown syntax",
        exact: true,
      });
      await expect(syntax).toHaveText(`${prefix} `);
      // Pausing at the shortcut must preserve the heading through autosave.
      await expect
        .poll(async () =>
          (await app.server.rpc.workspace.readFile({ path })).trimEnd(),
        )
        .toBe(prefix);
      await app.page.keyboard.type("First heading", { delay: 50 });
      await app.page
        .getByRole("button", { name: "New tab", exact: true })
        .focus();
      await expect(
        editor.getByRole("heading", {
          name: "First heading",
          exact: true,
          level,
        }),
      ).toBeVisible();
      await expect
        .poll(async () =>
          (await app.server.rpc.workspace.readFile({ path })).trimEnd(),
        )
        .toBe(`${prefix} First heading`);
      await app.page.reload();
      await expect(
        editor.getByRole("heading", {
          name: "First heading",
          exact: true,
          level,
        }),
      ).toBeVisible();
    },
  );
}

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
  "Tiptap leaves original line endings unchanged when only revealing formatting",
  async ({ app }) => {
    const path = "line-endings.md";
    const original =
      "## Heading\r\n\r\nBefore **bold** and _italic_ after.\r\n\r\nPlain paragraph.\r\n";
    await app.server.rpc.workspace.writeFile({ path, content: original });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByTestId("file-page-content").locator(".tiptap");
    const source = editor.getByRole("textbox", { name: "Markdown syntax" });
    await editor.locator("em").click();
    await expect(source).toHaveText("*italic*");
    await editor.getByText("Plain paragraph.", { exact: true }).click();
    await expect(source).toHaveCount(0);
    // Wait through the autosave debounce to detect reveal/blur being treated as edits.
    await app.page.waitForTimeout(750);
    expect(await app.server.rpc.workspace.readFile({ path })).toBe(original);
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
    let supportedProtocols: number[] | undefined = [
      haloProtocolVersion - 1,
      haloProtocolVersion,
    ];
    await app.page.route("**/rpc/server/info", async (route) => {
      if (supportedProtocols === undefined) {
        await route.continue();
        return;
      }
      await route.fulfill({
        json: {
          json: {
            protocolVersion: haloProtocolVersion - 1,
            supportedProtocols,
          },
        },
      });
    });
    await routeWorkspaceRpc(app.page, async (request) => {
      if (request.path !== "/server/info" || supportedProtocols === undefined) {
        request.continue();
        return;
      }
      await request.fulfill({
        json: { protocolVersion: haloProtocolVersion - 1, supportedProtocols },
      });
    });
    await app.page.reload();
    await expect(
      app.page.getByRole("status", {
        name: "Connection: Connected",
        exact: true,
      }),
    ).toBeVisible();
    supportedProtocols = [haloProtocolVersion - 1];
    await app.page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(
      app.page.getByRole("button", {
        name: "Connection: Server update required",
        exact: true,
      }),
    ).toBeVisible();
    supportedProtocols = undefined;
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
  "keeps the update page while retrying an older server",
  async ({ app }) => {
    const info = {
      protocolVersion: haloProtocolVersion - 1,
      supportedProtocols: [haloProtocolVersion - 1],
    };
    let hold = false;
    let held = 0;
    await app.page.route("**/rpc/server/info", async (route) => {
      if (hold) held++;
      else await route.fulfill({ json: { json: info } });
    });
    await routeWorkspaceRpc(app.page, async (request) => {
      if (request.path !== "/server/info") request.continue();
      else if (hold) held++;
      else await request.fulfill({ json: info });
    });
    await app.page.reload();
    const updatePage = app.page.getByText("Can't connect to your workspace", {
      exact: true,
    });
    await expect(updatePage).toBeVisible();
    hold = true;
    await app.page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect.poll(() => held).toBeGreaterThan(0);
    await expect(updatePage).toBeVisible();
    await expect(
      app.page.getByText("Opening your workspace", { exact: true }),
    ).toHaveCount(0);
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

e2eTest(
  "keeps moved Markdown images visible and copies them",
  async ({ app }) => {
    const path = "image-copy.md";
    await app.server.rpc.workspace.writeFile({
      path: "picture.svg",
      content:
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="blue"/></svg>',
    });
    await app.server.rpc.workspace.writeFile({
      path,
      content: "Before image\n\n![Picture](picture.svg)",
    });
    await app.page.getByRole("link", { name: path }).click();
    const editor = app.page
      .getByRole("main", { name: path })
      .getByLabel(path, { exact: true });
    const image = editor.getByRole("img", { name: "Picture" });
    await expect
      .poll(
        async () =>
          await image.evaluate((node: HTMLImageElement) => node.naturalWidth),
      )
      .toBe(80);

    await editor.getByText("Before image").click();
    await editor.press("End");
    await editor.press("Enter");
    await expect(image).toHaveAttribute("src", /^blob:/);
    await expect
      .poll(
        async () =>
          await image.evaluate((node: HTMLImageElement) => node.naturalWidth),
      )
      .toBe(80);
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .not.toBe("Before image\n\n![Picture](picture.svg)");

    await image.click({ button: "right" });
    await app.page.getByRole("button", { name: "Copy image" }).click();
    await expect(async () => {
      const hasImage = await app.page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        if (!items[0]?.types.includes("image/png")) return false;
        const png = await items[0].getType("image/png");
        return png.size > 0;
      });
      expect(hasImage).toBe(true);
    }).toPass({ timeout: 10_000 });

    await image.click();
    await app.page.evaluate(async () => {
      await navigator.clipboard.writeText("reset");
    });
    await app.page.keyboard.press("ControlOrMeta+c");
    await expect(async () => {
      const hasImage = await app.page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        if (!items[0]?.types.includes("image/png")) return false;
        const png = await items[0].getType("image/png");
        return png.size > 0;
      });
      expect(hasImage).toBe(true);
    }).toPass({ timeout: 10_000 });
  },
);

e2eTest(
  "Whim block selection navigates, edits, deletes, and undoes",
  async ({ app }) => {
    const path = "blocks.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content: "One\n\nTwo\n\nThree",
    });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByLabel(path, { exact: true });
    await clickEditorText(editor.getByText("Two", { exact: true }));
    await app.page.keyboard.press("Escape");
    await expect(editor.locator(".halo-selected-block")).toHaveText("Two");
    await app.page.keyboard.press("Shift+ArrowDown");
    await expect(editor.locator(".halo-selected-block")).toHaveText([
      "Two",
      "Three",
    ]);
    await app.page.keyboard.press("Shift+ArrowUp");
    await expect(editor.locator(".halo-selected-block")).toHaveText("Two");
    await app.page.keyboard.press("Alt+ArrowUp");
    await expect(editor.locator("p")).toHaveText(["Two", "One", "Three"]);
    await expect(editor.locator(".halo-selected-block")).toHaveText("Two");
    await app.page.keyboard.press("ControlOrMeta+z");
    await expect(editor.locator("p")).toHaveText(["One", "Two", "Three"]);
    await app.page.keyboard.press("Escape");
    await expect(editor.locator(".halo-selected-block")).toHaveCount(0);
    await app.page.keyboard.type("X");
    await expect(editor.locator("p").nth(1)).toHaveText("XTwo");
    await app.page.keyboard.press("Escape");
    await app.page.keyboard.press("Shift+ArrowDown");
    await app.page.keyboard.press("Backspace");
    await expect(editor.locator("p")).toHaveText(["One"]);
    await app.page.keyboard.press("ControlOrMeta+z");
    await expect(editor.locator("p")).toHaveText(["One", "XTwo", "Three"]);
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toContain("XTwo");
  },
);

e2eTest(
  "Whim list movement preserves nested content and task state",
  async ({ app }) => {
    const path = "moving-lists.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content:
        "- Parent\n  - Child\n- Other\n\nAfter\n\n- [x] Done\n- [x] Next",
    });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByLabel(path, { exact: true });
    await clickEditorText(editor.getByText("Other", { exact: true }));
    await app.page.keyboard.press("Alt+ArrowDown");
    await expect(editor.locator(":scope > p").first()).toHaveText("Other");
    await expect(editor.locator("ul:not([data-type])").first()).toContainText(
      "Child",
    );
    await app.page.keyboard.press("ControlOrMeta+z");
    await expect(editor.locator("ul:not([data-type])").first()).toContainText(
      "Other",
    );
    await clickEditorText(editor.getByText("Next", { exact: true }));
    await expect(
      editor.and(app.page.locator('[contenteditable="true"]')),
    ).toBeFocused();
    await app.page.keyboard.press("Tab");
    await expect(
      editor.locator('ul[data-type="taskList"] ul[data-type="taskList"]'),
    ).toContainText("Next");
    await app.page.keyboard.press("Shift+Tab");
    await expect(
      editor.locator('ul[data-type="taskList"] ul[data-type="taskList"]'),
    ).toHaveCount(0);
    await expect(
      editor.getByRole("checkbox", { name: "Task item checkbox for Done" }),
    ).toBeChecked();
    await expect(
      editor.getByRole("checkbox", { name: "Task item checkbox for Next" }),
    ).toBeChecked();
    await editor.getByText("Next", { exact: true }).evaluate((element) => {
      element.closest<HTMLElement>(".tiptap")!.focus();
      window.getSelection()!.collapse(element.firstChild, 4);
    });
    await app.page.keyboard.type(" edited");
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toContain("- [x] Done\n- [x] Next edited");
  },
);

e2eTest(
  "Whim backspace joins rich content and exits code blocks",
  async ({ app }) => {
    const path = "backspace.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content: "- First\n\n**Bold** after\n\n```\ncode\n```",
    });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByLabel(path, { exact: true });
    await editor.locator(":scope > p").evaluate((element) => {
      element.closest<HTMLElement>(".tiptap")!.focus();
      window.getSelection()!.collapse(element, 0);
    });
    await app.page.keyboard.press("Backspace");
    await expect(editor.locator("li strong")).toHaveText("Bold");
    await expect(editor.locator("li")).toHaveText("FirstBold after");
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toContain("- First**Bold** after");
    await editor.locator("pre code").evaluate((element) => {
      element.closest<HTMLElement>(".tiptap")!.focus();
      window.getSelection()!.collapse(element.firstChild, 0);
    });
    await app.page.keyboard.press("Backspace");
    await expect(editor.locator("pre")).toHaveCount(0);
    await expect(editor.locator(":scope > p").first()).toHaveText("code");
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toContain("\n\ncode");
  },
);

e2eTest(
  "Whim image drops save assets at the preview and preserve surrounding text",
  async ({ app, harness }) => {
    const path = "drop.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content: "Before\n\nAfter",
    });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByLabel(path, { exact: true });
    const png = await editor
      .getByText("After", { exact: true })
      .evaluate(async (element) => {
        const canvas = document.createElement("canvas");
        canvas.width = 2;
        canvas.height = 2;
        canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
        const blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((value) => resolve(value!)),
        );
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(
          new File([bytes], "dropped.png", { type: "image/png" }),
        );
        const box = element.getBoundingClientRect();
        const options = {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: box.left + 1,
          clientY: box.top + box.height / 2,
        };
        element.dispatchEvent(new DragEvent("dragover", options));
        element.dispatchEvent(new DragEvent("drop", options));
        return [...bytes];
      });
    await expect(
      editor.getByRole("img", { name: "dropped.png" }),
    ).toBeVisible();
    await expect(editor.locator(".halo-image-drop-preview")).toHaveCount(0);
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toContain("![dropped.png](image-");
    const markdown = await app.server.rpc.workspace.readFile({ path });
    expect(markdown).toContain("Before");
    expect(markdown).toContain("After");
    const asset = markdown.match(/\]\((image-[^)]+\.png)\)/)![1]!;
    expect(
      await fs.readFile(nodePath.join(harness.paths.workspace, asset)),
    ).toEqual(Buffer.from(png));
    await app.page.reload();
    await expect(
      editor.getByRole("img", { name: "dropped.png" }),
    ).toBeVisible();
  },
);

e2eTest(
  "Rich and source text stay editable while local links open",
  async ({ app }) => {
    const path = "editor-links.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content: "Before **bold** after\n\n[Target](target.md)",
    });
    await app.server.rpc.workspace.writeFile({
      path: "target.md",
      content: "Link target",
    });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByLabel(path, { exact: true });
    await editor.locator("strong").click();
    const source = editor.getByRole("textbox", { name: "Markdown syntax" });
    await expect(source).toHaveText("**bold**");
    await app.page.keyboard.type("X");
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toContain("X");
    await editor.getByRole("link", { name: "Target", exact: true }).click();
    await expect(
      app.page.getByRole("main", { name: path, exact: true }),
    ).toBeVisible();
    await source.press("Escape");
    await editor
      .getByRole("link", { name: "Target", exact: true })
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(
      app.page.getByRole("main", { name: "target.md", exact: true }),
    ).toHaveText(/Link target/);
  },
);

async function clickEditorText(text: Locator) {
  // The DOM caret moves before selectionchange updates the editor state read
  // by block and list commands. Wait for that event, not just the DOM anchor.
  await Promise.all([
    text.evaluate(
      async (element) =>
        await new Promise<void>((resolve) => {
          const selected = () => {
            const selection = document.getSelection();
            if (selection === null || !element.contains(selection.anchorNode))
              return;
            document.removeEventListener("selectionchange", selected);
            resolve();
          };
          document.addEventListener("selectionchange", selected);
        }),
    ),
    text.click(),
  ]);
}
