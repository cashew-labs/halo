import path from "node:path";
import { expect, type Page, type Route } from "@playwright/test";
import { m } from "@get-halo/shared/testing";
import { e2eTest } from "../e2eTest.js";

const output = "/Users/michaelkronovet/conductor/workspaces/halo/kingstown/.context/screenshots";
const viewports = [
  { label: "desktop-1280x800", width: 1280, height: 800 },
  { label: "mobile-390x844", width: 390, height: 844 },
];

async function capture(page: Page, state: string) {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(output, `${state}-${viewport.label}.png`),
    });
  }
  await page.setViewportSize(viewports[0]!);
}

e2eTest("captures upload states", async ({ app, harness }) => {
  await harness.loadSession({
    title: "Quarterly review",
    messages: [
      m.user("Can you look at last quarter's numbers?"),
      m.assistant("Sure. Attach the files and I will read them."),
    ],
  });
  const pane = app.page.getByRole("main", { name: "Quarterly review" });
  const editor = pane.getByLabel("Message", { exact: true });
  const held: Route[] = [];
  // Hold every chunk so the test controls progress.
  await app.page.route("**/rpc/uploads/write", (route) => {
    held.push(route);
  });
  await editor.fill("Summarize the recording and the deck");
  await pane.getByLabel("Attach files", { exact: true }).setInputFiles([
    {
      name: "all-hands-recording.mov",
      mimeType: "video/quicktime",
      buffer: Buffer.alloc(3 * 8 * 1024 * 1024, 1),
    },
    {
      name: "q3-board-deck.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.alloc(9 * 1024 * 1024, 2),
    },
  ]);
  await expect.poll(() => held.length).toBe(2);
  await held.shift()!.continue();
  await expect(
    pane.getByRole("list", { name: "Attachments", exact: true }),
  ).toContainText("33%");
  await capture(app.page, "1-composer-uploading");

  await pane.getByRole("button", { name: "Send", exact: true }).click();
  await editor.fill("Also compare it with Q2");
  await expect(pane.getByRole("log")).toContainText(
    "Sends when its files finish uploading",
  );
  await capture(app.page, "2-waiting-message");

  // Cancel one upload on the server so its next chunk fails.
  await pane
    .getByRole("button", { name: "Move queued message to draft", exact: true })
    .click();
  const route = held.shift()!;
  const uploadId = /"uploadId":"([^"]+)"/.exec(route.request().postData()!)![1]!;
  await app.server.rpc.uploads.cancel({ uploadId });
  await route.continue();
  await expect(
    pane.getByRole("list", { name: "Attachments", exact: true }),
  ).toContainText("Upload failed");
  await capture(app.page, "3-upload-failed");
});
