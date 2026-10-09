import { expect } from "@playwright/test";
import { e2eTest } from "../e2eTest.js";

e2eTest(
  "switches between desktop and native touch carets without moving typed text",
  async ({ app }, testInfo) => {
    const page = app.page;
    const cdp = await page.context().newCDPSession(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const input = page
      .locator('[data-testid="pane-tab-content"]:visible')
      .getByLabel("Message", { exact: true });
    const original =
      "First plain paragraph with enough words to wrap on a phone.\n\nSecond plain paragraph to move the cursor into.";
    await input.fill(original);
    await expect(input).toHaveClass(/halo-custom-caret/);
    await page.screenshot({
      path: testInfo.outputPath("desktop-composer-1280x900.png"),
      caret: "initial",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    await expect(input).not.toHaveClass(/halo-custom-caret/);
    await expect(
      page.locator(".halo-editor-caret").filter({ visible: true }),
    ).toHaveCount(0);
    await expect(input).not.toHaveCSS("caret-color", "rgba(0, 0, 0, 0)");
    for (const offset of [6, 25, 65]) {
      await input.fill(original);
      const point = await input.evaluate((el, offset) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode()!;
        let remaining = offset;
        while (remaining > node.textContent!.length) {
          remaining -= node.textContent!.length;
          node = walker.nextNode()!;
        }
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        const rect = range.getClientRects()[0]!;
        return { x: rect.left, y: rect.top + rect.height / 2 };
      }, offset);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [point],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await page.keyboard.insertText("HERE");
      const flat = original.replaceAll("\n", "");
      await expect(input).toHaveText(
        flat.slice(0, offset) + "HERE" + flat.slice(offset),
      );
    }
    await page.screenshot({
      path: testInfo.outputPath("mobile-composer-390x844.png"),
      caret: "initial",
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(input).toHaveClass(/halo-custom-caret/);
    const point = await input.evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.firstChild!.firstChild!, 3);
      range.collapse(true);
      const rect = range.getClientRects()[0]!;
      return { x: rect.left, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await expect(
      page.locator(".halo-editor-hover-caret").filter({ visible: true }),
    ).toHaveCount(1);
  },
);

e2eTest(
  "touch editing keeps native carets in Markdown source and subsequent paragraphs",
  async ({ app }, testInfo) => {
    const page = app.page;
    const path = "mobile.md";
    await app.server.rpc.workspace.writeFile({
      path,
      content:
        "Before **bold** after.\n\nSecond plain paragraph to move the cursor into.",
    });
    await page.getByRole("link", { name: path, exact: true }).click();
    const input = page.getByTestId("file-page-content").locator(".tiptap");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    await expect
      .poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches))
      .toBe(true);
    const strong = await input.locator("strong").boundingBox();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: strong!.x + strong!.width / 2, y: strong!.y + strong!.height / 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    const source = input.getByRole("textbox", { name: "Markdown syntax" });
    await expect(source).toBeVisible();
    await expect(source).not.toHaveCSS("caret-color", "rgba(0, 0, 0, 0)");
    await expect(
      page.locator(".halo-editor-caret").filter({ visible: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("mobile-markdown-source-390x844.png"),
      caret: "initial",
    });
    const point = await input
      .locator("p")
      .last()
      .evaluate((el) => {
        const range = document.createRange();
        range.setStart(el.firstChild!, 7);
        range.collapse(true);
        const rect = range.getClientRects()[0]!;
        return { x: rect.left, y: rect.top + rect.height / 2 };
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(source).toHaveCount(0);
    await page.keyboard.insertText("HERE");
    await expect(input).toContainText("Second HEREplain");
    await expect
      .poll(() => app.server.rpc.workspace.readFile({ path }))
      .toContain("Second HEREplain");
    await page
      .getByRole("button", { name: "Close mobile.md", exact: true })
      .click();
    await expect(input).toHaveCount(0);
  },
);
