import { expect } from "@playwright/test";
import { e2eTest } from "../e2eTest.js";
import { m } from "@get-halo/shared/testing";
import fs from "node:fs/promises";
import path from "node:path";

e2eTest("measures content loading", async ({ app, harness, server }) => {
  const timings: Record<string, unknown> = {};
  const started = performance.now();
  await expect(app.page.getByRole("main")).toBeVisible();
  timings.initialReady = performance.now() - started;
  timings.modules = await app.page.evaluate(
    () =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.endsWith(".js")).length,
  );
  const session = await harness.loadSession({
    title: "Loading measurement",
    messages: Array.from({ length: 20 }, (_, i) => [
      m.user(`Question ${i}`),
      m.assistant(
        `Response ${i}\n\n## Details\n\nSome **Markdown** text with a list:\n\n- One\n- Two\n`,
      ),
    ]).flat(),
  });
  await expect(app.page.getByRole("log")).toContainText("Response 19");
  await harness.tools.files.write({
    path: "loading-measurement.md",
    content: "# Loading measurement\n\nReady to edit.\n",
  });
  const requests: string[] = [];
  app.page.on("request", (request) => {
    if (/workspace\/(readFile|previewFile)/.test(request.url()))
      requests.push(request.url());
  });
  await app.page.route("**/rpc/workspace/*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });
  const fileStart = performance.now();
  await app.page
    .getByRole("link", { name: "loading-measurement.md", exact: true })
    .click();
  await expect(app.page.getByTestId("file-page-content")).toContainText(
    "Ready to edit",
  );
  timings.document = performance.now() - fileStart;
  timings.fileRequests = [...requests];
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("/workspace/previewFile");
  const editor = app.page
    .getByTestId("file-page-content")
    .locator('[contenteditable="true"]');
  await editor.fill("Updated document");
  await expect
    .poll(
      async () =>
        await server.rpc.workspace.readFile({ path: "loading-measurement.md" }),
    )
    .toContain("Updated document");
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await app.page.setViewportSize(viewport);
    await app.page.screenshot({
      path: path.resolve(
        `../../.context/document-${viewport.width}x${viewport.height}.png`,
      ),
    });
  }
  await app.page.setViewportSize({ width: 1280, height: 800 });
  await app.page.unrouteAll();
  const sessionStart = performance.now();
  await app.page
    .getByRole("link", { name: "Loading measurement", exact: true })
    .click();
  await expect(app.page.getByRole("log")).toContainText("Response 19");
  timings.session = performance.now() - sessionStart;
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await app.page.setViewportSize(viewport);
    await app.page.screenshot({
      path: path.resolve(
        `../../.context/session-${viewport.width}x${viewport.height}.png`,
      ),
    });
  }
  const snapshotStart = performance.now();
  await server.rpc.thread.snapshot({ sessionId: session.sessionId });
  timings.snapshotRpc = performance.now() - snapshotStart;
  await fs.mkdir(path.resolve("../../tmp/loading-speed"), { recursive: true });
  await fs.writeFile(
    path.resolve(
      `../../tmp/loading-speed/${process.env.LOADING_RUN ?? "baseline"}.json`,
    ),
    JSON.stringify(timings, undefined, 2),
  );
  console.log("LOADING_TIMINGS", JSON.stringify(timings));
});
