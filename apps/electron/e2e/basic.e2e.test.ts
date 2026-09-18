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
    app.page.getByRole("button", { name: "New session", exact: true }),
  ).toBeVisible();
  await expect(app.page.getByText(/^Halo \d+\.\d+\.\d+$/)).toBeVisible();

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
  "explains how to update when the workspace protocol is newer",
  async ({ app }) => {
    await expect(
      app.page.getByRole("main", { name: "New session" }),
    ).toBeVisible();
    await app.page.route("**/rpc/server/info", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ json: { protocolVersion: 999 } }),
      });
    });
    await app.page.reload();

    await expect(
      app.page.getByRole("heading", { name: "Update Halo to reconnect" }),
    ).toBeVisible();
    await expect(
      app.page.getByText(
        `This app uses protocol ${haloProtocolVersion}, while your server uses protocol 999.`,
      ),
    ).toBeVisible();
    await expect(
      app.page.getByText(
        "Test builds do not auto-update. Install the latest Halo release manually, then reopen the app.",
      ),
    ).toBeVisible();
    await expect(
      app.page.getByRole("button", { name: "View Halo downloads" }),
    ).toBeVisible();
  },
);

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
  "pastes images into Markdown and keeps relative images after reopening",
  async ({ app, harness }) => {
    const path = "Notes #1/Images.md";
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="blue"/></svg>';
    await app.server.rpc.workspace.writeFile({
      path: "reference #1.svg",
      content: svg,
    });
    await app.server.rpc.workspace.writeFile({
      path,
      content:
        "# Images\n\nPaste here\n\n![Reference](../reference%20%231.svg)",
    });
    await app.page
      .getByRole("button", { name: "Expand Notes #1", exact: true })
      .click();
    await app.page
      .getByRole("link", { name: "Images.md", exact: true })
      .click();
    const editor = app.page
      .getByRole("main", { name: path, exact: true })
      .getByLabel(path, { exact: true });
    await expect
      .poll(
        async () =>
          await editor
            .getByRole("img", { name: "Reference", exact: true })
            .evaluate((element: HTMLImageElement) => element.naturalWidth),
      )
      .toBe(80);
    const reference = editor.getByRole("img", {
      name: "Reference",
      exact: true,
    });
    await reference.click();
    await expect(reference).toHaveCSS("outline-style", "solid");
    await editor.getByText("Paste here", { exact: true }).click();
    await expect(reference).toHaveCSS("outline-style", "none");
    await editor.press("End");
    const png = await editor.evaluate(async (element) => {
      const canvas = document.createElement("canvas");
      canvas.width = 120;
      canvas.height = 80;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#d97706";
      context.fillRect(0, 0, 120, 80);
      const bytes = await (await fetch(canvas.toDataURL())).arrayBuffer();
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([bytes], "screen]shot.png", { type: "image/png" }),
      );
      clipboardData.items.add(
        new File([bytes], "second.png", { type: "image/png" }),
      );
      clipboardData.setData(
        "text/html",
        '<img src="https://example.invalid/duplicate.png">',
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData,
          bubbles: true,
          cancelable: true,
        }),
      );
      return [...new Uint8Array(bytes)];
    });
    await expect(editor.getByRole("img")).toHaveCount(3);
    await expect
      .poll(
        async () =>
          await editor
            .getByRole("img", { name: "screen]shot.png", exact: true })
            .evaluate((element: HTMLImageElement) => element.naturalWidth),
      )
      .toBe(120);
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toContain("![second.png](image-");
    const markdown = await app.server.rpc.workspace.readFile({ path });
    const sources = [...markdown.matchAll(/\]\((image-[^)]+\.png)\)/g)].map(
      (match) => match[1]!,
    );
    expect(sources).toHaveLength(2);
    expect(new Set(sources).size).toBe(2);
    for (const src of sources) {
      expect(
        await fs.readFile(
          nodePath.join(harness.paths.workspace, "Notes #1", src),
        ),
      ).toEqual(Buffer.from(png));
    }
    expect(markdown).toContain("![Reference](../reference%20%231.svg)");
    expect(markdown).not.toContain("blob:");
    await app.quit();
    await app.open();

    await app.page
      .getByRole("button", { name: "Expand Notes #1", exact: true })
      .click();
    await app.page
      .getByRole("link", { name: "Images.md", exact: true })
      .click();
    await expect(
      app.page
        .getByRole("main", { name: path, exact: true })
        .getByLabel(path, { exact: true })
        .getByRole("img"),
    ).toHaveCount(3);
    await expect
      .poll(
        async () =>
          await app.page
            .getByRole("main", { name: path, exact: true })
            .getByLabel(path, { exact: true })
            .getByRole("img", { name: "screen]shot.png", exact: true })
            .evaluate((element: HTMLImageElement) => element.naturalWidth),
      )
      .toBe(120);
  },
);

e2eTest("keeps the current file after reload", async ({ app }) => {
  const path = "Meeting notes #1.md";
  await app.server.rpc.workspace.writeFile({
    path,
    content: "# Meeting notes",
  });
  await app.page.getByRole("link", { name: path }).click();
  const filePane = app.page.getByRole("main", { name: path });
  await expect(filePane.getByLabel(path, { exact: true })).toHaveText(
    "Meeting notes",
  );

  await app.page.reload();

  await expect(filePane).toBeVisible();
  await expect(filePane.getByLabel(path, { exact: true })).toHaveText(
    "Meeting notes",
  );
});

e2eTest(
  "places the markdown cursor at the end when clicking below the text",
  async ({ app }) => {
    await app.server.rpc.workspace.writeFile({
      path: "notes.md",
      content: "# Title\n\nLast line",
    });

    await app.page.getByRole("link", { name: "notes.md" }).click();
    const filePane = app.page.getByRole("main", { name: "notes.md" });
    const editor = filePane.getByLabel("notes.md", { exact: true });
    await editor.getByRole("heading", { name: "Title" }).click();
    const pageContent = filePane.getByTestId("file-page-content");
    const size = await pageContent.evaluate((element) => ({
      width: element.clientWidth,
      height: element.clientHeight,
    }));
    await pageContent.click({
      position: { x: size.width / 2, y: size.height - 20 },
    });

    await expect(editor).toBeFocused();
    await app.page.keyboard.type(" appended");
    await expect(
      editor.getByText("Last line appended", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          await app.server.rpc.workspace.readFile({ path: "notes.md" }),
      )
      .toContain("Last line appended");
  },
);

e2eTest(
  "indents selected bullets after deleting the gap between lists",
  async ({ app }) => {
    await app.server.rpc.workspace.writeFile({ path: "lists.md", content: "" });
    await app.page.getByRole("link", { name: "lists.md", exact: true }).click();
    const editor = app.page
      .getByRole("main", { name: "lists.md" })
      .getByLabel("lists.md", { exact: true });
    await editor.fill("");
    await app.page.keyboard.type("- Parent");
    await app.page.keyboard.press("Enter");
    await app.page.keyboard.press("Enter");
    await app.page.keyboard.press("Enter");
    await app.page.keyboard.type("- Second");
    await app.page.keyboard.press("Enter");
    await app.page.keyboard.type("Child");
    await app.page.keyboard.press("Tab");
    await app.page.keyboard.press("Enter");
    await app.page.keyboard.press("Shift+Tab");
    await app.page.keyboard.type("Third");
    await expect(editor.locator(":scope > ul")).toHaveCount(2);

    await editor.locator(":scope > p").first().click();
    await app.page.keyboard.press("Backspace");
    await expect(editor.locator(":scope > ul")).toHaveCount(1);
    await editor.evaluate(async (element) => {
      const paragraphs = [...element.querySelectorAll("p")];
      const start = paragraphs.find((p) => p.textContent === "Second")!;
      const end = paragraphs.find((p) => p.textContent === "Third")!;
      // ProseMirror reads the DOM selection when Chromium emits selectionchange.
      const selectionChanged = new Promise<void>((resolve) => {
        document.addEventListener("selectionchange", () => resolve(), {
          once: true,
        });
      });
      window
        .getSelection()!
        .setBaseAndExtent(start, 0, end, end.childNodes.length);
      await selectionChanged;
    });
    await app.page.keyboard.press("Tab");
    const nested = editor.locator(":scope > ul > li > ul > li > p");
    await expect(nested).toHaveText(["Second", "Third"]);
    await expect(editor.locator("ul ul ul > li > p")).toHaveText(["Child"]);
    await expect(editor).toBeFocused();

    await app.page.keyboard.press("Shift+Tab");
    await expect(editor.locator(":scope > ul > li > p")).toHaveText([
      "Parent",
      "Second",
      "Third",
    ]);
    await app.page.keyboard.press("Tab");
    await expect(nested).toHaveText(["Second", "Third"]);
    await expect
      .poll(
        async () =>
          await app.server.rpc.workspace.readFile({ path: "lists.md" }),
      )
      .toContain("- Parent\n  - Second\n    - Child\n  - Third");
    await app.page.reload();
    await expect(nested).toHaveText(["Second", "Third"]);
    await expect(editor.locator("ul ul ul > li > p")).toHaveText(["Child"]);

    // Chromium reports selectionchange asynchronously after a pointer press.
    await editor.getByText("Third", { exact: true }).click({ delay: 50 });
    await app.page.keyboard.press("Shift+Tab");
    await expect(editor.locator(":scope > ul > li > p")).toHaveText([
      "Parent",
      "Third",
    ]);
    await app.page.keyboard.press("ControlOrMeta+z");
    await expect(nested).toHaveText(["Second", "Third"]);
    await app.page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(editor.locator(":scope > ul > li > p")).toHaveText([
      "Parent",
      "Third",
    ]);
    await app.page.keyboard.press("Tab");
    await expect(nested).toHaveText(["Second", "Third"]);

    await editor.getByText("Parent", { exact: true }).click({ delay: 50 });
    await app.page.keyboard.press("Tab");
    await expect(editor).toBeFocused();
    await expect(editor.locator(":scope > ul > li > p")).toHaveText(["Parent"]);
  },
);

e2eTest(
  "indents a loaded Markdown list with mixed bullet markers",
  async ({ app }) => {
    await app.server.rpc.workspace.writeFile({
      path: "markers.md",
      content: "- Parent\n+ Second\n* Third",
    });
    await app.page
      .getByRole("link", { name: "markers.md", exact: true })
      .click();
    const editor = app.page
      .getByRole("main", { name: "markers.md" })
      .getByLabel("markers.md", { exact: true });
    await expect(editor.locator(":scope > ul")).toHaveCount(1);
    await editor.getByText("Third", { exact: true }).click({ delay: 50 });
    await app.page.keyboard.press("Tab");
    await expect(editor.locator("ul ul > li > p")).toHaveText(["Third"]);
    await expect(editor).toBeFocused();
  },
);

e2eTest(
  "joins pasted bullet lists at every depth so individual bullets can indent",
  async ({ app }) => {
    await app.server.rpc.workspace.writeFile({ path: "paste.md", content: "" });
    await app.page.getByRole("link", { name: "paste.md", exact: true }).click();
    const editor = app.page
      .getByRole("main", { name: "paste.md" })
      .getByLabel("paste.md", { exact: true });
    await editor.fill("");
    await editor.evaluate((element) => {
      const data = new DataTransfer();
      data.setData(
        "text/html",
        "<ul><li><p>Parent</p></li></ul>" +
          "<ul><li><p>Second</p><ul><li><p>Child</p></li></ul>" +
          "<ul><li><p>Another child</p></li></ul></li></ul>" +
          "<ul><li><p>Third</p></li></ul>" +
          "<p>Separate section</p><ul><li><p>Separate bullet</p></li></ul>" +
          '<ol start="3"><li><p>Numbered</p></li></ol>',
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(editor.locator(":scope > ul")).toHaveCount(2);
    await expect(editor.locator("ul ul")).toHaveCount(1);
    const second = editor.getByText("Second", { exact: true });
    await second.click({ position: { x: 5, y: 10 } });
    await expect
      .poll(
        async () =>
          await second.evaluate((paragraph) => {
            const selection = paragraph.ownerDocument.getSelection();
            return (
              selection?.isCollapsed === true &&
              paragraph.contains(selection.anchorNode) &&
              paragraph.contains(selection.focusNode)
            );
          }),
      )
      .toBe(true);
    await app.page.keyboard.press("Tab");
    await expect(editor.locator("ul ul > li > p")).toHaveText([
      "Second",
      "Child",
      "Another child",
    ]);
    await expect(editor.locator("ul ul ul > li > p")).toHaveText([
      "Child",
      "Another child",
    ]);
    await expect(editor.locator(":scope > ul > li > p")).toHaveText([
      "Parent",
      "Third",
      "Separate bullet",
    ]);
    await expect(editor.locator("ol")).toHaveAttribute("start", "3");
    await expect(editor).toBeFocused();
  },
);

e2eTest(
  "creates and organizes notes through the Files sidebar",
  async ({ app }) => {
    const page = app.page;
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    const folderName = page.getByRole("textbox", { name: "New folder name" });
    await folderName.fill("Notes");
    await folderName.press("Enter");
    await page
      .getByRole("button", { name: "Actions for Notes", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "New file…", exact: true })
      .click();
    const fileName = page.getByRole("textbox", { name: "New file name" });
    await fileName.fill("Today.md");
    await fileName.press("Enter");
    const editor = page
      .getByRole("main", { name: "Notes/Today.md", exact: true })
      .getByLabel("Notes/Today.md", { exact: true });
    await editor.fill("My latest edit");

    await page
      .getByRole("button", { name: "Actions for Today.md", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("Plan.md");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(
      page.getByRole("main", { name: "Notes/Plan.md", exact: true }),
    ).toContainText("My latest edit");

    await page
      .getByRole("button", { name: "Actions for Plan.md", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Move to…", exact: true }).click();
    await page.getByRole("button", { name: /Move to$/ }).click();
    await page.getByRole("option", { name: "Workspace", exact: true }).click();
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(
      page.getByRole("main", { name: "Plan.md", exact: true }),
    ).toContainText("My latest edit");
    expect(
      await app.server.rpc.workspace.readFile({ path: "Plan.md" }),
    ).toContain("My latest edit");
    expect(await app.server.rpc.workspace.listPaths()).toEqual([
      "Notes/",
      "Plan.md",
    ]);

    await page.getByRole("button", { name: "New file", exact: true }).click();
    await fileName.fill("Plan.md");
    await fileName.press("Enter");
    await expect(page.getByRole("alert")).toContainText("already exists");
    await fileName.press("Escape");
    await page.reload();
    await expect(
      page.getByRole("main", { name: "Plan.md", exact: true }),
    ).toContainText("My latest edit");
  },
);

e2eTest(
  "moves folders by dragging and keeps the open note selected",
  async ({ app }) => {
    await app.server.rpc.workspace.writeFile({
      path: "Inbox/Notes/Today.md",
      content: "A note to move",
    });
    await app.server.rpc.workspace.createEntry({
      path: "Archive",
      kind: "directory",
    });
    const page = app.page;
    await page
      .getByRole("button", { name: "Expand Inbox", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Expand Notes", exact: true })
      .click();
    await page.getByRole("link", { name: "Today.md", exact: true }).click();
    await page
      .getByRole("main", { name: "Inbox/Notes/Today.md", exact: true })
      .getByLabel("Inbox/Notes/Today.md", { exact: true })
      .fill("Edited before dragging");
    const source = page.locator('[data-file-path="Inbox/Notes"]');
    const target = page.getByRole("row", { name: "Archive", exact: true });
    const root = page.getByRole("row").filter({
      has: page.getByRole("button", { name: "New folder", exact: true }),
    });
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await source.dispatchEvent("dragstart", { dataTransfer: transfer });
    await target
      .getByRole("button", { name: "Expand Archive", exact: true })
      .dispatchEvent("dragover", { dataTransfer: transfer });
    await expect(target).toHaveAttribute("data-drop-target", "true");
    await expect(root).not.toHaveAttribute("data-drop-target", "true");
    const menu = target.getByRole("button", {
      name: "Actions for Archive",
      exact: true,
    });
    await menu.dispatchEvent("dragover", { dataTransfer: transfer });
    await expect(target).toHaveAttribute("data-drop-target", "true");
    await root
      .getByRole("button", { name: "New folder", exact: true })
      .dispatchEvent("dragover", { dataTransfer: transfer });
    await expect(root).toHaveAttribute("data-drop-target", "true");
    await expect(target).not.toHaveAttribute("data-drop-target", "true");
    await source.dispatchEvent("dragend", { dataTransfer: transfer });
    await expect(page.locator('[data-drop-target="true"]')).toHaveCount(0);
    await transfer.dispose();
    await source.dragTo(menu);
    await expect(
      page.getByRole("main", { name: "Archive/Notes/Today.md", exact: true }),
    ).toContainText("Edited before dragging");
    await expect(
      page.getByRole("button", { name: "Actions for Today.md", exact: true }),
    ).toBeVisible();
    expect(await app.server.rpc.workspace.listPaths()).toEqual([
      "Archive/Notes/Today.md",
      "Inbox/",
    ]);
    await page.reload();
    await expect(
      page.getByRole("main", { name: "Archive/Notes/Today.md", exact: true }),
    ).toContainText("Edited before dragging");
    await page
      .locator('[data-file-path="Archive/Notes"]')
      .dragTo(root, { targetPosition: { x: 100, y: 14 } });
    await expect(
      page.getByRole("main", { name: "Notes/Today.md", exact: true }),
    ).toContainText("Edited before dragging");
    expect(await app.server.rpc.workspace.listPaths()).toEqual([
      "Archive/",
      "Inbox/",
      "Notes/Today.md",
    ]);
  },
);

e2eTest(
  "keeps unsaved edits when a rename cannot save, then retries after repair",
  async ({ app, harness }) => {
    await app.server.rpc.workspace.writeFile({
      path: "notes.md",
      content: "Original",
    });
    const page = app.page;
    await page.getByRole("link", { name: "notes.md", exact: true }).click();
    const editor = page
      .getByRole("main", { name: "notes.md", exact: true })
      .getByLabel("notes.md", { exact: true });
    await expect(editor).toHaveText("Original");
    const file = nodePath.join(harness.paths.workspace, "notes.md");
    await fs.unlink(file);
    await fs.mkdir(file);
    await editor.fill("Keep this unsaved edit");
    await page
      .getByRole("button", { name: "Actions for notes.md", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("renamed.md");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      "Failed to save notes.md",
    );
    await fs.rmdir(file);
    await app.server.rpc.workspace.writeFile({
      path: "notes.md",
      content: "Original",
    });
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(
      page.getByRole("main", { name: "renamed.md", exact: true }),
    ).toContainText("Keep this unsaved edit");
    expect(await app.server.rpc.workspace.listPaths()).toEqual(["renamed.md"]);
    expect(
      await app.server.rpc.workspace.readFile({ path: "renamed.md" }),
    ).toContain("Keep this unsaved edit");
  },
);

e2eTest(
  "confirms folder deletion and closes its open file",
  async ({ app }) => {
    await app.server.rpc.workspace.writeFile({
      path: "Notes/Today.md",
      content: "# Today",
    });
    await app.server.rpc.workspace.writeFile({
      path: "Keep.md",
      content: "# Keep",
    });
    const page = app.page;
    await page
      .getByRole("button", { name: "Expand Notes", exact: true })
      .click();
    await page.getByRole("link", { name: "Today.md", exact: true }).click();
    const editor = page
      .getByRole("main", { name: "Notes/Today.md" })
      .getByLabel("Notes/Today.md", { exact: true });
    await editor.fill("Latest edit");
    await page
      .getByRole("button", { name: "Actions for Notes", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toBeVisible();
    await page
      .getByRole("button", { name: "Actions for Notes", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("main", { name: "New session" })).toBeVisible();
    await expect
      .poll(async () => await app.server.rpc.workspace.listPaths())
      .toEqual(["Keep.md"]);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Actions for Notes", exact: true }),
    ).toHaveCount(0);
  },
);

e2eTest("edits plain text and displays an image preview", async ({ app }) => {
  await app.server.rpc.workspace.writeFile({
    path: "notes.txt",
    content: "Plain text",
  });
  await app.server.rpc.workspace.writeFile({
    path: "picture.svg",
    content:
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="blue"/></svg>',
  });
  const page = app.page;
  await page.getByRole("link", { name: "notes.txt", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "notes.txt",
    exact: true,
  });
  await expect(editor).toHaveValue("Plain text");
  await editor.fill("Saved plain text");
  await expect
    .poll(
      async () =>
        await app.server.rpc.workspace.readFile({ path: "notes.txt" }),
    )
    .toBe("Saved plain text");
  await page.getByRole("link", { name: "picture.svg", exact: true }).click();
  const image = page.getByRole("img", { name: "picture.svg", exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(
      async () =>
        await image.evaluate(
          (element: HTMLImageElement) => element.naturalWidth,
        ),
    )
    .toBe(80);
  await page.getByRole("link", { name: "notes.txt", exact: true }).click();
  await expect(editor).toHaveValue("Saved plain text");
});

e2eTest(
  "renders a PDF with the built-in document viewer",
  async ({ app, harness }) => {
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    const stream = "BT /F1 20 Tf 30 240 Td (Halo PDF preview) Tj ET";
    objects.push(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = pdf.length;
    pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    pdf += offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join("");
    pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    await fs.writeFile(
      nodePath.join(harness.paths.workspace, "document.pdf"),
      pdf,
    );
    const page = app.page;
    await page.getByRole("link", { name: "document.pdf", exact: true }).click();
    const viewerUrl = /^chrome-extension:\/\/.*\/index.html$/;
    await expect
      .poll(() => page.frames().some((frame) => viewerUrl.test(frame.url())))
      .toBe(true);
    const viewer = page.frame({ url: viewerUrl });
    if (viewer === null) throw new Error("PDF viewer did not open");
    await expect(
      viewer.getByRole("textbox", { name: "Page number", exact: true }),
    ).toHaveValue("1");
    await expect(
      page.getByRole("button", { name: "Open externally", exact: true }),
    ).toHaveCount(0);
  },
);

e2eTest(
  "plays audio and explains unsupported binary files",
  async ({ app, harness }) => {
    const wav = Buffer.alloc(44 + 16000);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(16000, 40);
    await fs.writeFile(
      nodePath.join(harness.paths.workspace, "recording.wav"),
      wav,
    );
    await fs.writeFile(
      nodePath.join(harness.paths.workspace, "archive.zip"),
      Buffer.from([80, 75, 0, 255]),
    );
    const page = app.page;
    await page
      .getByRole("link", { name: "recording.wav", exact: true })
      .click();
    const player = page.locator('audio[aria-label="recording.wav"]');
    await expect(player).toBeVisible();
    await expect
      .poll(
        async () =>
          await player.evaluate(
            (element: HTMLAudioElement) => element.duration,
          ),
      )
      .toBe(1);
    await page.getByRole("link", { name: "archive.zip", exact: true }).click();
    await expect(
      page.getByText("This file type has no preview."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open externally", exact: true }),
    ).toHaveCount(0);
  },
);

e2eTest(
  "names new files inline, preserves extensions, and cancels with Escape",
  async ({ harness, app }) => {
    const page = app.page;
    await page.getByRole("button", { name: "New file", exact: true }).click();
    const name = page.getByRole("textbox", { name: "New file name" });
    await expect(name).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await name.fill("discard.txt");
    await name.press("Escape");
    await expect(name).toHaveCount(0);
    expect(await app.server.rpc.workspace.listPaths()).toEqual([]);
    await page.getByRole("button", { name: "New file", exact: true }).click();
    await name.fill("notes.txt");
    await page.getByText("Files", { exact: true }).click();
    await expect(
      page.getByRole("main", { name: "notes.txt", exact: true }),
    ).toBeVisible();
    expect(await app.server.rpc.workspace.listPaths()).toEqual(["notes.txt"]);
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    const folder = page.getByRole("textbox", { name: "New folder name" });
    await folder.fill("Archive");
    await folder.press("Enter");
    await expect(folder).toHaveCount(0);
    expect(
      (
        await fs.stat(nodePath.join(harness.paths.workspace, "Archive"))
      ).isDirectory(),
    ).toBe(true);
    const collapse = page.getByRole("button", {
      name: "Collapse Archive",
      exact: true,
    });
    const expand = page.getByRole("button", {
      name: "Expand Archive",
      exact: true,
    });
    await collapse.click();
    await expand.click();
    await expect(collapse).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(expand).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(collapse).toBeVisible();
    await page.reload();
    await expand.click();
    await expect(collapse).toBeVisible();
    await page
      .locator('[data-file-path="notes.txt"]')
      .dragTo(page.locator('[data-file-path="Archive"]'));
    await expect(
      page.getByRole("main", { name: "Archive/notes.txt", exact: true }),
    ).toBeVisible();
    expect(await app.server.rpc.workspace.listPaths()).toEqual([
      "Archive/notes.txt",
    ]);
    await app.server.rpc.workspace.deleteEntry({ path: "Archive/notes.txt" });
    await expect(
      page.locator('[data-file-path="Archive/notes.txt"]'),
    ).toHaveCount(0);
    await collapse.click();
    await expect(expand).toBeVisible();
  },
);

e2eTest("uses a dismissible sidebar on small screens", async ({ app }) => {
  const page = app.page;
  await expect(page.getByRole("main", { name: "New session" })).toBeVisible();
  await app.server.rpc.workspace.writeFile({
    path: "Mobile notes.md",
    content: "# Mobile notes\n\nA full-width page.",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const open = page.getByRole("button", { name: "Open sidebar", exact: true });
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(open).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await page.getByLabel("Message", { exact: true }).fill("Keep this draft");
  await open.click();
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: "New session", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(
      async () =>
        await page
          .getByRole("main")
          .evaluate((element) => element.closest("[inert]") !== null),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect(page.getByLabel("Message", { exact: true })).toHaveText(
    "Keep this draft",
  );

  await open.click();
  await drawer
    .getByRole("link", { name: "Mobile notes.md", exact: true })
    .click();
  await expect(drawer).toHaveCount(0);
  await expect(
    page.getByRole("main", { name: "Mobile notes.md" }),
  ).toBeVisible();
  await open.click();
  await drawer
    .getByRole("link", { name: "Mobile notes.md", exact: true })
    .click();
  await expect(drawer).toHaveCount(0);

  for (const width of [320, 390, 700]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.getByRole("main").evaluate((element) => element.clientWidth),
    ).toBe(width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await open.click();
    await expect(drawer).toBeVisible();
    await page.mouse.click(width - 10, 100);
    await expect(drawer).toHaveCount(0);
  }

  const newSession = page
    .locator(".paneTabBar")
    .getByRole("button", { name: "New session", exact: true });
  await expect(newSession).toHaveText("");
  await newSession.click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("main", { name: "New session" })).toBeVisible();
  await open.click();
  await drawer
    .getByRole("button", { name: "Close sidebar", exact: true })
    .click();
  await expect(drawer).toHaveCount(0);
  await open.click();
  await page.setViewportSize({ width: 1024, height: 844 });
  await expect(drawer).toHaveCount(0);
  await expect(open).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "New session", exact: true }),
  ).toBeVisible();
  expect(
    await page.getByRole("main").evaluate((element) => element.clientWidth),
  ).toBe(784);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(open).toBeVisible();
  await expect(drawer).toHaveCount(0);
});

e2eTest(
  "removes heading formatting with Backspace without deleting or joining text",
  async ({ app }) => {
    await app.server.rpc.workspace.writeFile({
      path: "format.md",
      content: "# First\n\nParagraph\n\n## Second",
    });
    await app.page
      .getByRole("link", { name: "format.md", exact: true })
      .click();
    const editor = app.page
      .getByRole("main", { name: "format.md" })
      .getByLabel("format.md", { exact: true });

    for (const name of ["First", "Second"]) {
      await editor.getByRole("heading", { name }).click({ delay: 50 });
      await editor.getByRole("heading", { name }).evaluate(async (heading) => {
        const selectionChanged = new Promise<void>((resolve) => {
          document.addEventListener("selectionchange", () => resolve(), {
            once: true,
          });
        });
        window.getSelection()!.collapse(heading.firstChild, 0);
        await selectionChanged;
      });
      await app.page.keyboard.press("Backspace");
      await expect(editor.locator("p", { hasText: name })).toHaveText(name);
      await app.page.keyboard.press("ControlOrMeta+z");
      await expect(editor.getByRole("heading", { name })).toBeVisible();
      await app.page.keyboard.press("ControlOrMeta+Shift+z");
      await expect(editor.locator("p", { hasText: name })).toHaveText(name);
    }
    await expect(
      editor.locator(":scope > p").filter({ hasText: /\S/ }),
    ).toHaveText(["First", "Paragraph", "Second"]);
    await expect
      .poll(async () =>
        (
          await app.server.rpc.workspace.readFile({ path: "format.md" })
        ).trimEnd(),
      )
      .toBe("First\n\nParagraph\n\nSecond");
    await app.page.reload();
    await expect(editor.locator("h1, h2")).toHaveCount(0);
    await expect(
      editor.locator(":scope > p").filter({ hasText: /\S/ }),
    ).toHaveText(["First", "Paragraph", "Second"]);
  },
);

e2eTest(
  "clears selected Markdown formatting and stops carrying it into new text",
  async ({ app }) => {
    await app.server.rpc.workspace.writeFile({
      path: "format.md",
      content: "# **Title**\n\n**Bold** and *italic*",
    });
    await app.page
      .getByRole("link", { name: "format.md", exact: true })
      .click();
    const editor = app.page
      .getByRole("main", { name: "format.md" })
      .getByLabel("format.md", { exact: true });
    await editor.click();
    await app.page.keyboard.press("ControlOrMeta+a");
    await app.page.keyboard.press("ControlOrMeta+\\");
    await expect(editor.locator("h1, strong, em")).toHaveCount(0);
    await expect(editor.locator("p")).toHaveText(["Title", "Bold and italic"]);
    await app.page.keyboard.press("ControlOrMeta+z");
    await expect(editor.locator("h1 strong")).toHaveText("Title");
    await expect(editor.locator("p strong")).toHaveText("Bold");
    await expect(editor.locator("em")).toHaveText("italic");
    await app.page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(editor.locator("h1, strong, em")).toHaveCount(0);
    await expect
      .poll(
        async () =>
          await app.server.rpc.workspace.readFile({ path: "format.md" }),
      )
      .toBe("Title\n\nBold and italic");
    await app.page.reload();
    await expect(editor.locator("p")).toHaveText(["Title", "Bold and italic"]);
    await expect(editor.locator("h1, strong, em")).toHaveCount(0);

    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const message = app.page
      .getByRole("main", { name: "New session" })
      .getByLabel("Message", { exact: true });
    await message.fill("");
    await app.page.keyboard.press("ControlOrMeta+b");
    await app.page.keyboard.type("Bold");
    await expect(message.locator("strong")).toHaveText("Bold");
    await app.page.keyboard.press("ControlOrMeta+\\");
    await app.page.keyboard.type(" plain");
    await expect(message).toHaveText("Bold plain");
    await expect(message.locator("strong")).toHaveText("Bold");
    await app.page.keyboard.press("ControlOrMeta+a");
    await app.page.keyboard.press("ControlOrMeta+\\");
    await expect(message.locator("strong")).toHaveCount(0);
    await expect(message).toHaveText("Bold plain");

    await message.fill("");
    await app.page.keyboard.type("# ");
    await expect(message.locator("h1")).toHaveCount(1);
    await app.page.keyboard.press("Backspace");
    await expect(message.locator("h1")).toHaveCount(0);
    await app.page.keyboard.type("Plain");
    await expect(message.locator("h1")).toHaveCount(0);
    await expect(message).toContainText("Plain");
  },
);

e2eTest(
  "opens Command-clicked Markdown and assistant links in the system browser",
  async ({ app, harness }) => {
    const opened = await app.observeExternalUrls();
    const url = "https://example.com/guide?q=halo%20app#start";
    await app.server.rpc.workspace.writeFile({
      path: "Links.md",
      content: `Read [project docs](${url}).`,
    });
    await app.page.getByRole("link", { name: "Links.md", exact: true }).click();
    const editor = app.page.getByRole("main", { name: "Links.md" });
    const docs = editor.getByRole("link", { name: "project docs" });
    await docs.click();
    await expect(editor.locator(".markdown-source")).toHaveText(
      `[project docs](${url})`,
    );
    expect(await opened.evaluate((urls) => urls)).toEqual([]);
    await docs.click({ modifiers: ["Meta"] });
    await expect
      .poll(async () => await opened.evaluate((urls) => urls))
      .toEqual([url]);
    await expect(editor).toBeVisible();
    await harness.loadSession({
      title: "Helpful links",
      messages: [
        m.user("Show a link"),
        m.assistant(`Open [**project docs**](${url}).`),
      ],
    });
    await app.page
      .getByRole("log")
      .getByRole("link", { name: "project docs" })
      .click({ modifiers: ["Meta"] });
    await expect
      .poll(async () => await opened.evaluate((urls) => urls))
      .toEqual([url, url]);
    await expect(
      app.page.getByRole("main", { name: "Helpful links" }),
    ).toBeVisible();
    await opened.dispose();
  },
);

e2eTest(
  "uploads dropped local files, images and nested folders to the workspace",
  async ({ app, harness }) => {
    const local = nodePath.join(harness.paths.root, "local-files");
    const folder = nodePath.join(local, "Research");
    await fs.mkdir(nodePath.join(folder, "empty"), { recursive: true });
    await fs.mkdir(nodePath.join(folder, "batch"));
    await fs.writeFile(nodePath.join(folder, ".DS_Store"), "Finder metadata");
    await fs.mkdir(nodePath.join(folder, ".git"));
    await fs.mkdir(nodePath.join(folder, "node_modules"));
    await fs.writeFile(
      nodePath.join(local, "notes.txt"),
      "Notes from this computer",
    );
    const image =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>';
    await fs.writeFile(nodePath.join(local, "picture.svg"), image);
    await Promise.all(
      Array.from({ length: 105 }, async (_, index) => {
        await fs.writeFile(
          nodePath.join(folder, "batch", `note-${index}.txt`),
          `Local note ${index}`,
        );
      }),
    );
    const header = app.page.getByRole("row").filter({
      has: app.page.getByRole("button", { name: "New file", exact: true }),
    });
    await dropLocalPaths({
      target: header,
      paths: [
        nodePath.join(local, "notes.txt"),
        nodePath.join(local, "picture.svg"),
        folder,
      ],
    });
    await expect(app.page.getByRole("status")).toHaveText(
      "Uploaded 110 items. Skipped 3 hidden or dependency items.",
      { timeout: 20_000 },
    );
    expect(await app.server.rpc.workspace.readFile({ path: "notes.txt" })).toBe(
      "Notes from this computer",
    );
    expect(
      await app.server.rpc.workspace.readFile({
        path: "Research/batch/note-104.txt",
      }),
    ).toBe("Local note 104");
    expect(await app.server.rpc.workspace.listPaths()).toContain(
      "Research/empty/",
    );
    await app.page
      .getByRole("link", { name: "picture.svg", exact: true })
      .click();
    await expect(app.page.getByRole("main").getByRole("img")).toBeVisible();
    expect(
      await fs.readFile(
        nodePath.join(harness.paths.workspace, "picture.svg"),
        "utf8",
      ),
    ).toBe(image);

    await app.server.rpc.workspace.createEntry({
      path: "Archive",
      kind: "directory",
    });
    await dropLocalPaths({
      target: app.page.locator('[data-file-path="Archive"]'),
      paths: [nodePath.join(local, "notes.txt")],
    });
    await expect(app.page.getByRole("status")).toHaveText("Uploaded 1 item.");
    expect(
      await app.server.rpc.workspace.readFile({ path: "Archive/notes.txt" }),
    ).toBe("Notes from this computer");
    await fs.writeFile(
      nodePath.join(local, "notes.txt"),
      "Do not overwrite the VM file",
    );
    await dropLocalPaths({
      target: app.page.locator('[data-file-path="Archive"]'),
      paths: [nodePath.join(local, "notes.txt")],
    });
    await expect(app.page.getByRole("alert")).toContainText("already exists");
    expect(
      await app.server.rpc.workspace.readFile({ path: "Archive/notes.txt" }),
    ).toBe("Notes from this computer");
  },
);

async function dropLocalPaths({
  target,
  paths,
}: {
  target: Locator;
  paths: string[];
}) {
  await expect(target).toBeVisible();
  const bounds = await target.boundingBox();
  if (bounds === null) throw new Error("The file drop target is not visible");
  const client = await target.page().context().newCDPSession(target.page());
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  const position = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  await client.send("Input.dispatchDragEvent", {
    type: "dragEnter",
    ...position,
    data,
  });
  await client.send("Input.dispatchDragEvent", {
    type: "dragOver",
    ...position,
    data,
  });
  await client.send("Input.dispatchDragEvent", {
    type: "drop",
    ...position,
    data,
  });
  await client.detach();
}

e2eTest(
  "opens sidebar items in replaceable tabs and preserves inactive drafts",
  async ({ app }) => {
    const page = app.page;
    await app.server.rpc.workspace.writeFile({
      path: "One.md",
      content: "# One",
    });
    await app.server.rpc.workspace.writeFile({
      path: "Two.md",
      content: "# Two",
    });
    await page.getByLabel("Message", { exact: true }).fill("Keep my draft");
    await page
      .getByRole("link", { name: "One.md", exact: true })
      .click({ modifiers: ["Meta"] });
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(
      page.getByRole("tab", { name: "One.md", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("link", { name: "Two.md", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(
      page.getByRole("main", { name: "Two.md", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "One.md", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("tab", { name: "New session", exact: true }).click();
    await expect(page.getByLabel("Message", { exact: true })).toHaveText(
      "Keep my draft",
    );
    await page
      .getByRole("tab", { name: "New session", exact: true })
      .press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: "Two.md", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Close Two.md", exact: true })
      .click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(page.getByLabel("Message", { exact: true })).toHaveText(
      "Keep my draft",
    );
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
    await page.getByRole("tab", { name: "Two.md", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("tab")).toHaveText([
      "New session",
      "One.md",
      "Two.md",
      "Three.md",
    ]);
    await expect(
      page.getByRole("tab", { name: "Two.md", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("main", { name: "Two.md", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close Two.md", exact: true })
      .click();
    await page.reload();
    await expect(page.getByRole("tab")).toHaveText([
      "New session",
      "One.md",
      "Three.md",
    ]);
    await expect(
      page.getByRole("tab", { name: "Three.md", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await app.quit();
    await app.open();
    await expect(app.page.getByRole("tab")).toHaveText([
      "New session",
      "One.md",
      "Three.md",
    ]);
    await expect(
      app.page.getByRole("tab", { name: "Three.md", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    // A full navigation loads the URL before the pane manager starts.
    await app.page.evaluate(() =>
      window.history.replaceState(undefined, "", "#/files/Two.md"),
    );
    await app.page.reload();
    await expect(app.page.getByRole("tab")).toHaveText([
      "New session",
      "One.md",
      "Three.md",
      "Two.md",
    ]);
    await expect(
      app.page.getByRole("tab", { name: "Two.md", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await app.page.evaluate(() =>
      window.history.replaceState(undefined, "", "#/files/One.md"),
    );
    await app.page.reload();
    await expect(app.page.getByRole("tab")).toHaveCount(4);
    await expect(
      app.page.getByRole("tab", { name: "One.md", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  },
);

e2eTest(
  "splits panes with tabs and sidebar items, then moves and closes them",
  async ({ app, harness }) => {
    await harness.loadSession({ title: "Pane conversation", messages: [] });
    const page = app.page;
    await app.server.rpc.workspace.writeFile({
      path: "Left.md",
      content: "# Left",
    });
    await app.server.rpc.workspace.writeFile({
      path: "Right.md",
      content: "# Right",
    });
    await page.getByRole("link", { name: "Left.md", exact: true }).click();
    await page
      .getByRole("link", { name: "Right.md", exact: true })
      .click({ modifiers: ["Meta"] });
    const area = page.locator(".paneWorkspace");
    const box = (await area.boundingBox())!;
    await page
      .getByRole("tab", { name: "Right.md", exact: true })
      .dragTo(area, {
        targetPosition: { x: box.width - 10, y: box.height / 2 },
      });
    await expect(page.getByRole("tablist")).toHaveCount(2);
    await expect(
      page.getByRole("main", { name: "Left.md", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("main", { name: "Right.md", exact: true }),
    ).toBeVisible();
    const right = (await page
      .getByRole("main", { name: "Right.md", exact: true })
      .boundingBox())!;
    const left = (await page
      .getByRole("main", { name: "Left.md", exact: true })
      .boundingBox())!;
    expect(right.x).toBeGreaterThan(left.x);
    await page
      .getByRole("link", { name: "Pane conversation", exact: true })
      .locator("span")
      .dragTo(area, {
        targetPosition: { x: box.width * 0.75, y: box.height - 10 },
      });
    await expect(page.getByRole("tablist")).toHaveCount(3);
    await page
      .getByRole("main", { name: "Pane conversation", exact: true })
      .getByLabel("Message", { exact: true })
      .fill("Unsent draft survives moving");
    await page
      .getByRole("tab", { name: "Pane conversation", exact: true })
      .dragTo(area, {
        targetPosition: { x: box.width * 0.25, y: box.height / 2 },
      });
    await expect(page.getByRole("tablist")).toHaveCount(2);
    await expect(page.getByLabel("Message", { exact: true })).toHaveText(
      "Unsent draft survives moving",
    );
    const divider = page.getByRole("separator", { name: "Resize panes" });
    await divider.focus();
    await divider.press("ArrowRight");
    await expect(divider).toHaveAttribute("aria-valuenow", "55");
    await page.getByRole("tab", { name: "Right.md", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("tablist")).toHaveCount(2);
    await expect(page.getByRole("tablist").first().getByRole("tab")).toHaveText(
      ["Left.md", "Pane conversation"],
    );
    await expect(
      page.getByRole("tab", { name: "Pane conversation", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("tab", { name: "Right.md", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(divider).toHaveAttribute("aria-valuenow", "55");
    await expect(page.getByLabel("Message", { exact: true })).toBeEditable();
    // Allow editor mount autofocus and its animation frame to finish.
    await page.evaluate(
      async () =>
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(
      page.locator('.workspacePane[data-active="true"]').getByRole("tab"),
    ).toHaveText("Right.md");
    await expect(page).toHaveURL(/#\/files\/Right.md$/);
    await page
      .getByLabel("Message", { exact: true })
      .fill("Unsent draft survives moving");
    await page
      .getByRole("button", { name: "Close Right.md", exact: true })
      .click();
    await expect(page.getByRole("tablist")).toHaveCount(1);
    await expect(page.getByLabel("Message", { exact: true })).toHaveText(
      "Unsent draft survives moving",
    );
  },
);

for (const edge of ["left", "top", "bottom"] as const) {
  e2eTest(
    `opens a sidebar file at the ${edge} edge without moving it on disk`,
    async ({ app }) => {
      const page = app.page;
      await app.server.rpc.workspace.writeFile({
        path: "Keep.md",
        content: "# Keep",
      });
      await app.server.rpc.workspace.writeFile({
        path: "Drop.md",
        content: "# Drop",
      });
      await page.getByRole("link", { name: "Keep.md", exact: true }).click();
      const area = page.locator(".paneWorkspace");
      const box = (await area.boundingBox())!;
      await page.locator('[data-file-path="Drop.md"]').dragTo(area, {
        targetPosition: {
          x: edge === "left" ? 10 : box.width / 2,
          y:
            edge === "top"
              ? 45
              : edge === "bottom"
                ? box.height - 10
                : box.height / 2,
        },
      });
      await expect(page.getByRole("tablist")).toHaveCount(2);
      const keep = (await page
        .getByRole("main", { name: "Keep.md", exact: true })
        .boundingBox())!;
      const drop = (await page
        .getByRole("main", { name: "Drop.md", exact: true })
        .boundingBox())!;
      if (edge === "left") expect(drop.x).toBeLessThan(keep.x);
      else if (edge === "top") expect(drop.y).toBeLessThan(keep.y);
      else expect(drop.y).toBeGreaterThan(keep.y);
      expect(await app.server.rpc.workspace.listPaths()).toEqual([
        "Drop.md",
        "Keep.md",
      ]);
      await page
        .getByRole("main", { name: "Keep.md", exact: true })
        .getByLabel("Keep.md", { exact: true })
        .click();
      await page.getByRole("link", { name: "Drop.md", exact: true }).click();
      await expect(
        page.getByRole("main", { name: "Drop.md", exact: true }),
      ).toHaveCount(2);
    },
  );
}

e2eTest(
  "Tiptap reveals an editable fragment after the pointer settles without saving",
  async ({ app }) => {
    const path = "tiptap.md";
    const original =
      "## Heading\n\nBefore **bold text** between *italic text* after.\n\nPlain paragraph.";
    await app.server.rpc.workspace.writeFile({ path, content: original });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByTestId("file-page-content").locator(".tiptap");
    const bold = editor.locator("strong");
    const bounds = (await bold.boundingBox())!;
    await app.page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await app.page.mouse.down();
    await app.page.mouse.move(
      bounds.x + bounds.width / 2 + 1,
      bounds.y + bounds.height / 2,
    );
    await expect(editor.locator(".markdown-source")).toHaveCount(0);
    await app.page.mouse.up();
    const source = editor.getByRole("textbox", {
      name: "Markdown syntax",
      exact: true,
    });
    await expect(source).toHaveText("**bold text**");
    await expect(source.locator(".markdown-marker")).toHaveText(["**", "**"]);
    expect(
      await source.evaluate(() => window.getSelection()!.isCollapsed),
    ).toBe(true);
    await app.page.keyboard.type("X");
    await app.page.keyboard.press("ControlOrMeta+z");
    await expect(source).toHaveText("**bold text**");
    await editor.locator("em").click();
    await expect(source).toHaveText("*italic text*");
    await editor.getByText("Plain paragraph.", { exact: true }).click();
    await expect(source).toHaveCount(0);
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toBe(original);
    await app.page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toBe(original);
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
  "Tiptap retains rich HTML paste and nested lists with Markdown reveal",
  async ({ app }) => {
    const path = "paste.md";
    await app.server.rpc.workspace.writeFile({ path, content: "Start here" });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByTestId("file-page-content").locator(".tiptap");
    await editor.fill("");
    await editor.evaluate((element) => {
      const data = new DataTransfer();
      data.setData(
        "text/html",
        "<p><strong>Rich bold</strong> and <em>italic</em></p><ul><li>Parent<ul><li>Child</li></ul></li><li>Second</li></ul>",
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(editor.locator("strong")).toHaveText("Rich bold");
    await expect(editor.locator("ul ul li")).toHaveText("Child");
    await editor.locator("strong").click();
    await expect(
      editor.getByRole("textbox", { name: "Markdown syntax" }),
    ).toHaveText("**Rich bold**");
    await editor.getByText("Second", { exact: true }).click();
    await expect(editor.locator(".markdown-source")).toHaveCount(0);
    await app.page.keyboard.press("Tab");
    await expect(editor.locator("ul ul li")).toHaveText(["Child", "Second"]);
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toContain("**Rich bold** and *italic*");
  },
);

e2eTest(
  "Tiptap keeps the caret during source typing and delimiter deletion",
  async ({ app }) => {
    const path = "caret.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content: "Before **bold** after.\n\nPlain paragraph.",
    });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByTestId("file-page-content").locator(".tiptap");
    await editor.locator("strong").click();
    const source = editor.getByRole("textbox", { name: "Markdown syntax" });
    await expect(source).toHaveText("**bold**");
    await source
      .locator(".markdown-source-bold")
      .evaluate((element) =>
        window.getSelection()!.collapse(element.firstChild, 2),
      );
    await app.page.keyboard.type("XYZ");
    await expect(source).toHaveText("**boXYZld**");
    await source
      .locator(".markdown-marker")
      .first()
      .evaluate((element) =>
        window.getSelection()!.collapse(element.firstChild, 1),
      );
    await app.page.keyboard.press("Backspace");
    await expect(source).toHaveText("*boXYZld**");
    await app.page.keyboard.press("ControlOrMeta+z");
    await expect(source).toHaveText("**bold**");
    await source.press("ControlOrMeta+a");
    await app.page.keyboard.press("ControlOrMeta+\\");
    await expect(editor.locator("strong, em, .markdown-source")).toHaveCount(0);
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toBe("Before bold after.\n\nPlain paragraph.");
  },
);

e2eTest(
  "Tiptap keeps intentional drag selections and reveals nested marks, code, and links",
  async ({ app }) => {
    const path = "elements.md";
    const original =
      "Before **bold and *italic*** between `code` and [a link](https://example.com).\n\nPlain paragraph.";
    await app.server.rpc.workspace.writeFile({ path, content: original });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByTestId("file-page-content").locator(".tiptap");
    const bold = (await editor.locator("strong").boundingBox())!;
    await app.page.mouse.move(bold.x + 2, bold.y + bold.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(
      bold.x + bold.width - 2,
      bold.y + bold.height / 2,
      { steps: 12 },
    );
    await app.page.mouse.up();
    await expect(editor.locator(".markdown-source")).toHaveCount(0);
    expect(
      await editor.evaluate(() => window.getSelection()!.toString()),
    ).toContain("bold and italic");
    await editor.locator("em").click();
    const source = editor.getByRole("textbox", { name: "Markdown syntax" });
    await expect(source).toHaveText("**bold and *italic***");
    await editor.locator("code").click();
    await expect(source).toHaveText("`code`");
    await editor.getByRole("link").click();
    await expect(source).toHaveText("[a link](https://example.com)");
    await editor.getByText("Plain paragraph.", { exact: true }).click();
    await expect(source).toHaveCount(0);
    expect(await app.server.rpc.workspace.readFile({ path })).toBe(original);
  },
);

e2eTest(
  "Tiptap preserves multiline and rich paste inside a revealed fragment",
  async ({ app }) => {
    const path = "source-paste.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content: "Before **bold** after.",
    });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByTestId("file-page-content").locator(".tiptap");
    await editor.locator("strong").click();
    const source = editor.getByRole("textbox", { name: "Markdown syntax" });
    await expect(source).toHaveText("**bold**");
    await source
      .locator(".markdown-source-bold")
      .evaluate((element) =>
        window.getSelection()!.collapse(element.firstChild, 2),
      );
    await source.evaluate((element) => {
      const data = new DataTransfer();
      data.setData("text/plain", "ONE\n\nTWO");
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(editor).toContainText("ONE");
    await expect(editor).toContainText("TWO");
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toContain("TWO");
    await editor.locator("strong").first().click();
    await expect(source).toHaveCount(1);
    await source.evaluate((element) => {
      const data = new DataTransfer();
      data.setData("text/html", "<em>Rich italic</em>");
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(editor.locator("em")).toHaveText("Rich italic");
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toContain("*Rich italic*");
  },
);

e2eTest(
  "Tiptap hands keyboard movement and Enter back to the rich editor",
  async ({ app }) => {
    const path = "keyboard.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content: "Before **bold** after.\n\nPlain paragraph.",
    });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByTestId("file-page-content").locator(".tiptap");
    await editor.locator("strong").click();
    const source = editor.getByRole("textbox", { name: "Markdown syntax" });
    await expect(source).toHaveText("**bold**");
    await source
      .locator(".markdown-marker")
      .last()
      .evaluate((element) =>
        window.getSelection()!.collapse(element.firstChild, 2),
      );
    await app.page.keyboard.press("ArrowRight");
    await expect(source).toHaveCount(0);
    await app.page.keyboard.type("NEXT");
    await expect(editor).toHaveText("Before bold NEXTafter.Plain paragraph.");
    await editor.locator("strong").click();
    await expect(source).toHaveText("**bold**");
    await source
      .locator(".markdown-source-bold")
      .evaluate((element) =>
        window.getSelection()!.collapse(element.firstChild, 2),
      );
    await app.page.keyboard.press("Enter");
    await expect(source).toHaveCount(0);
    await expect(editor.locator(":scope > p")).toHaveText([
      "Before bo",
      "ld NEXTafter.",
      "Plain paragraph.",
    ]);
    await app.page.keyboard.press("ArrowDown");
    await expect(source).toHaveCount(0);
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toContain("Before **bo**\n\n**ld** NEXTafter.");
  },
);

e2eTest(
  "Tiptap reveals one-character formatting without revealing adjacent text",
  async ({ app }) => {
    const path = "short.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content: "Before **A** and *B* after.",
    });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByTestId("file-page-content").locator(".tiptap");
    const source = editor.getByRole("textbox", { name: "Markdown syntax" });
    await editor.locator("strong").click();
    await expect(source).toHaveText("**A**");
    await editor.locator("em").click();
    await expect(source).toHaveText("*B*");
    await source.press("Escape");
    await expect(source).toHaveCount(0);
    await app.page.keyboard.press("ControlOrMeta+ArrowRight");
    await app.page.keyboard.type(" Plain.");
    await expect(source).toHaveCount(0);
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toBe("Before **A** and *B* after. Plain.");
  },
);

e2eTest(
  "Tiptap leaves IME candidate keys inside the source fragment until composition commits",
  async ({ app }) => {
    const path = "composition.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content: "Before **bold** after.",
    });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByTestId("file-page-content").locator(".tiptap");
    await editor.locator("strong").click();
    const source = editor.getByRole("textbox", { name: "Markdown syntax" });
    await expect(source).toHaveText("**bold**");
    const retained = await source.evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      element.textContent = "**日本語**";
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: "日本語",
          isComposing: true,
        }),
      );
      const keys = ["ArrowDown", "ArrowUp", "Enter"].map((key) => {
        const event = new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          isComposing: true,
        });
        element.dispatchEvent(event);
        return {
          connected: element.isConnected,
          prevented: event.defaultPrevented,
        };
      });
      element.dispatchEvent(
        new CompositionEvent("compositionend", {
          bubbles: true,
          data: "日本語",
        }),
      );
      return keys;
    });
    expect(retained).toEqual(
      Array.from({ length: 3 }, () => ({ connected: true, prevented: false })),
    );
    await expect(source).toHaveText("**日本語**");
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toBe("Before **日本語** after.");
    await source.press("Escape");
    await expect(editor.locator("strong")).toHaveText("日本語");
  },
);

e2eTest(
  "Tiptap preserves block-like punctuation inside inline source edits",
  async ({ app }) => {
    const path = "inline-prefix.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content: "Before **bold** after.\n\nPlain paragraph.",
    });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByTestId("file-page-content").locator(".tiptap");
    const source = editor.getByRole("textbox", { name: "Markdown syntax" });
    await editor.locator("strong").click();
    await expect(source).toHaveText("**bold**");
    await source.fill("# **title**");
    await editor.getByText("Plain paragraph.", { exact: true }).click();
    await expect(source).toHaveCount(0);
    await expect(editor.locator("p").first()).toHaveText(
      "Before # title after.",
    );
    await expect(editor.locator("strong")).toHaveText("title");
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toContain("Before # **title** after.");
    await app.page.reload();
    await expect(editor.locator("p").first()).toHaveText(
      "Before # title after.",
    );
  },
);

e2eTest(
  "Tiptap keeps the caret beside escaped characters in both source and rich text",
  async ({ app }) => {
    const path = "entities.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content: "Before **a & b** after.",
    });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByTestId("file-page-content").locator(".tiptap");
    await editor.locator("strong").evaluate((element) => {
      element.closest<HTMLElement>(".tiptap")!.focus();
      window.getSelection()!.collapse(element.firstChild, 4);
    });
    const source = editor.getByRole("textbox", { name: "Markdown syntax" });
    await expect(source).toHaveText("**a &amp; b**");
    expect(
      await source.evaluate((element) => {
        const selection = window.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(element);
        range.setEnd(selection.anchorNode!, selection.anchorOffset);
        return range.toString();
      }),
    ).toBe("**a &amp; ");
    await app.page.keyboard.type("X");
    await expect(source).toHaveText("**a &amp; Xb**");
    await source.press("Escape");
    await app.page.keyboard.type("Y");
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toBe("Before **a &amp; XYb** after.");
    await app.page.reload();
    await expect(editor.locator("strong")).toHaveText("a & XYb");
  },
);

e2eTest(
  "Tiptap preserves literal backticks and code padding when editing and reopening",
  async ({ app }) => {
    const path = "backticks.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content: "Before `` `code` `` after.\n\nPlain paragraph.",
    });
    await app.page.getByRole("link", { name: path, exact: true }).click();
    const editor = app.page.getByTestId("file-page-content").locator(".tiptap");
    await expect(editor.locator("code")).toHaveText("`code`");
    await editor.locator("code").evaluate((element) => {
      element.closest<HTMLElement>(".tiptap")!.focus();
      window.getSelection()!.collapse(element.firstChild, 3);
    });
    const source = editor.getByRole("textbox", { name: "Markdown syntax" });
    await expect(source).toHaveText("`` `code` ``");
    await app.page.keyboard.type("X");
    await expect(source).toHaveText("`` `coXde` ``");
    await source.press("Escape");
    await app.page.keyboard.type("Y");
    await expect
      .poll(async () => await app.server.rpc.workspace.readFile({ path }))
      .toContain("Before `` `coXYde` `` after.");
    await app.page.reload();
    await expect(editor.locator("code")).toHaveText("`coXYde`");
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
  "opens fresh chat tabs with the keyboard and preserves drafts",
  async ({ app }) => {
    const page = app.page;
    await page
      .getByRole("tabpanel")
      .getByLabel("Message", { exact: true })
      .fill("Keep my draft");
    await app.pressShortcut({ key: "T" });
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(
      page.getByRole("tabpanel").getByLabel("Message", { exact: true }),
    ).toHaveText("");
    await app.pressShortcut({ key: "T" });
    await expect(page.getByRole("tab")).toHaveCount(3);
    await page.getByRole("tab").first().click();
    await expect(
      page.getByRole("tabpanel").getByLabel("Message", { exact: true }),
    ).toHaveText("Keep my draft");
  },
);

e2eTest(
  "creates hotkeys through chat and applies updates without restarting",
  async ({ app, llm }) => {
    const page = app.page;
    await page
      .getByRole("tabpanel")
      .getByLabel("Message", { exact: true })
      .fill("Make Cmd+Shift+K open a new chat tab");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(
      m.tool.start("exec", {
        id: "create-hotkey",
        arguments: {
          js: 'return await tools.hotkeys.save({ label: "Quick chat", accelerator: "CmdOrCtrl+Shift+K", action: { type: "newTab" } });',
        },
      }),
    );
    await llm.respond(m.assistant("Your Quick chat hotkey is ready."));
    await expect(
      page.getByText("Your Quick chat hotkey is ready.", { exact: true }),
    ).toBeVisible();
    await app.pressShortcut({ key: "P" });
    await expect(
      page.getByRole("menuitem", { name: "Quick chat" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await app.pressShortcut({ key: "K", shift: true });
    await expect(page.getByRole("tab")).toHaveCount(2);
    await page
      .getByRole("tabpanel")
      .getByLabel("Message", { exact: true })
      .fill("Keep this draft too");
    await app.pressShortcut({ key: "K", shift: true });
    await expect(page.getByRole("tab")).toHaveCount(3);
    await expect(
      page.getByRole("tabpanel").getByLabel("Message", { exact: true }),
    ).toHaveText("");
    const [hotkey] = await app.server.rpc.hotkeys.list();
    await app.server.rpc.workspace.writeFile({
      path: "Hotkey notes.md",
      content: "# Opened by hotkey",
    });
    await app.server.rpc.hotkeys.save({
      ...hotkey!,
      label: "Open notes",
      accelerator: "CmdOrCtrl+Shift+L",
      action: { type: "openFile", path: "Hotkey notes.md" },
    });
    await app.pressShortcut({ key: "P" });
    await expect(
      page.getByRole("menuitem", { name: "Open notes" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Quick chat" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await app.pressShortcut({ key: "K", shift: true });
    await expect(page.getByRole("tab")).toHaveCount(3);
    await app.pressShortcut({ key: "L", shift: true });
    await expect(
      page.getByRole("tab", { name: "Hotkey notes.md", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await app.quit();
    await app.open();
    await expect(app.page.getByRole("tabpanel")).toBeVisible();
    await app.pressShortcut({ key: "P" });
    await expect(
      app.page.getByRole("menuitem", { name: "Open notes" }),
    ).toBeVisible();
    await app.page.keyboard.press("Escape");
    await app.pressShortcut({ key: "L", shift: true });
    await expect(
      app.page.getByRole("tab", { name: "Hotkey notes.md", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await app.server.rpc.hotkeys.remove({ id: hotkey!.id });
    await app.pressShortcut({ key: "P" });
    await expect(
      app.page.getByRole("menuitem", { name: "Open notes" }),
    ).toHaveCount(0);
    await app.server.rpc.hotkeys.save({
      label: "My shortcuts",
      accelerator: "CmdOrCtrl+Shift+Alt+7",
      action: { type: "shortcutMenu" },
    });
    await expect(
      app.page.getByRole("menuitem", { name: "My shortcuts" }),
    ).toBeVisible();
    await app.page.keyboard.press("Escape");
    await app.pressShortcut({ key: "7", shift: true, alt: true });
    await expect(
      app.page.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
  },
);
