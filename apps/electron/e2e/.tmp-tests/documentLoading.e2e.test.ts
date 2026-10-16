import { expect } from "@playwright/test";
import { e2eTest } from "../e2eTest.js";

e2eTest(
  "loads and edits documents with one content request",
  async ({ app }, info) => {
    await app.server.rpc.workspace.writeFile({
      path: "loading.md",
      content: "# Loading speed\n\nOriginal content",
    });
    const requests: string[] = [];
    await app.page.route(
      /\/rpc\/workspace\/(previewFile|readFile)/,
      async (route) => {
        requests.push(new URL(route.request().url()).pathname);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.continue();
      },
    );
    const started = performance.now();
    await app.page
      .getByRole("link", { name: "loading.md", exact: true })
      .click();
    const editor = app.page
      .getByRole("main", { name: "loading.md", exact: true })
      .getByLabel("loading.md", { exact: true });
    await expect(editor).toContainText("Original content");
    console.log(
      JSON.stringify({
        documentMs: Math.round(performance.now() - started),
        requests,
      }),
    );
    expect(requests.filter((url) => url.endsWith("/previewFile"))).toHaveLength(
      1,
    );
    expect(requests.filter((url) => url.endsWith("/readFile"))).toHaveLength(0);
    await editor.fill("Edited after loading");
    await expect
      .poll(() => app.server.rpc.workspace.readFile({ path: "loading.md" }))
      .toContain("Edited after loading");
    await app.page.reload();
    await expect(editor).toHaveText("Edited after loading");
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await app.page.setViewportSize(viewport);
      await app.page.screenshot({
        path: info.outputPath(
          `document-${viewport.width}x${viewport.height}.png`,
        ),
      });
    }
  },
);

e2eTest(
  "opens plain text and source code from their preview content",
  async ({ app }) => {
    for (const file of [
      { path: "plain.txt", content: "Plain text preview" },
      { path: "source.ts", content: "const loadingSpeed = 42;" },
    ]) {
      await app.server.rpc.workspace.writeFile(file);
      expect(
        await app.server.rpc.workspace.previewFile({ path: file.path }),
      ).toEqual({ kind: "text", content: file.content });
      await app.page
        .getByRole("link", { name: file.path, exact: true })
        .click();
      const pane = app.page.getByRole("main", { name: file.path, exact: true });
      if (file.path.endsWith(".txt")) {
        const editor = pane.getByRole("textbox", { name: file.path });
        await expect(editor).toHaveValue(file.content);
        await editor.fill("Edited plain text");
        await expect
          .poll(() => app.server.rpc.workspace.readFile({ path: file.path }))
          .toBe("Edited plain text");
      } else
        await expect(
          pane.getByText(file.content, { exact: true }),
        ).toBeVisible();
    }
  },
);
