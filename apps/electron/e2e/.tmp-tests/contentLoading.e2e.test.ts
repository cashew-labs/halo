import { expect } from "@playwright/test";
import { e2eTest } from "../e2eTest.js";
import { m } from "@get-halo/shared/testing";

e2eTest(
  "loads session content and an interactive extension",
  async ({ app, harness }, info) => {
    await harness.loadSession({
      title: "Loading session",
      messages: [
        m.user("Show the session"),
        m.assistant("Session content loaded"),
      ],
    });
    await expect(
      app.page.getByRole("main", { name: "Loading session" }).getByRole("log"),
    ).toContainText("Session content loaded");
    await harness.loadExtension("../fixtures/greeting");
    const bundle = app.page.waitForResponse((response) =>
      response.url().endsWith("/view/assets/view.js"),
    );
    const started = performance.now();
    await app.page.getByRole("link", { name: "greeting", exact: true }).click();
    const pane = app.page.frameLocator('iframe[title="greeting"]');
    await pane.getByRole("textbox", { name: "Your name" }).fill("Ada");
    await pane.getByRole("button", { name: "Greet", exact: true }).click();
    await expect(pane.getByRole("status")).toHaveText("Hello, Ada!");
    const bytes = (await (await bundle).body()).byteLength;
    console.log(
      JSON.stringify({
        extensionMs: Math.round(performance.now() - started),
        extensionJavaScriptBytes: bytes,
      }),
    );
    if (process.env.LOADING_BASELINE !== "1")
      expect(bytes).toBeLessThan(1_000_000);
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await app.page.setViewportSize(viewport);
      await app.page.screenshot({
        path: info.outputPath(
          `extension-${viewport.width}x${viewport.height}.png`,
        ),
      });
    }
  },
);
