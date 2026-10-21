import fs from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route } from "@playwright/test";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import { e2eTest } from "../e2eTest.js";

const chunk = 8 * 1024 * 1024;

/** Holds chunk uploads until the test releases them. */
async function holdChunks(page: Page) {
  const held: Route[] = [];
  let holding = true;
  await page.route("**/rpc/uploads/write", async (route) => {
    if (!holding) {
      await route.continue();
      return;
    }
    held.push(route);
  });
  return {
    held,
    async release() {
      holding = false;
      for (const route of held.splice(0)) await route.continue();
    },
  };
}

function largeFile(name: string) {
  return {
    name,
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(chunk + 1024, 7),
  };
}

e2eTest(
  "uploads files as soon as they are attached and shows their progress",
  async ({ app, harness }) => {
    await harness.loadSession({
      title: "Attach early",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Attach early" });
    const chunks = await holdChunks(app.page);
    await pane
      .getByLabel("Attach files", { exact: true })
      .setInputFiles(largeFile("archive.bin"));
    const chip = pane
      .getByRole("list", { name: "Attachments", exact: true })
      .getByRole("listitem");
    await expect.poll(() => chunks.held.length).toBe(1);
    await expect(chip).toContainText("archive.bin");
    await expect(chip).toContainText("0%");
    await chunks.held.shift()!.continue();
    await expect(chip).toContainText("99%");
    await chunks.release();
    await expect(chip).not.toContainText("%");
  },
);

e2eTest(
  "moves a waiting message back to the draft without restarting its upload",
  async ({ app, harness, llm }) => {
    await harness.loadSession({
      title: "Withdraw waiting",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Withdraw waiting" });
    const editor = pane.getByLabel("Message", { exact: true });
    const chunks = await holdChunks(app.page);
    await editor.fill("Not yet");
    await pane
      .getByLabel("Attach files", { exact: true })
      .setInputFiles(largeFile("later.bin"));
    await expect.poll(() => chunks.held.length).toBe(1);
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await pane
      .getByRole("button", { name: "Move queued message to draft", exact: true })
      .click();
    await expect(editor).toHaveText("Not yet");
    const chip = pane
      .getByRole("list", { name: "Attachments", exact: true })
      .getByRole("listitem");
    await expect(chip).toContainText("0%");
    // Withdrawing did not start a new upload: only the first chunk is waiting.
    await app.page.waitForTimeout(500);
    expect(chunks.held).toHaveLength(1);
    await chunks.release();
    await expect(chip).not.toContainText("%");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) => {
      expect(
        messageText(messages.findLast((message) => message.role === "user")!),
      ).toContain("later.bin");
      return m.assistant("Got it.");
    });
  },
);

e2eTest(
  "marks a failed upload, retries it, and returns a waiting message to the draft",
  async ({ app, harness, llm }) => {
    await harness.loadSession({
      title: "Retry upload",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Retry upload" });
    const editor = pane.getByLabel("Message", { exact: true });
    const chunks = await holdChunks(app.page);
    await editor.fill("Read this");
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("coral raven"),
    });
    await expect.poll(() => chunks.held.length).toBe(1);
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    // Cancelling on the server makes the held chunk fail as a rejected upload.
    const route = chunks.held.shift()!;
    const uploadId = /"uploadId":"([^"]+)"/.exec(route.request().postData()!)![1]!;
    await app.server.rpc.uploads.cancel({ uploadId });
    await chunks.release();
    await route.continue();
    await expect(pane.getByRole("alert")).toHaveText(
      "This upload no longer exists. Attach the file again.",
    );
    await expect(editor).toHaveText("Read this");
    const chip = pane
      .getByRole("list", { name: "Attachments", exact: true })
      .getByRole("listitem");
    await expect(chip).toContainText("Upload failed");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect(pane.getByRole("alert")).toHaveText(
      "Retry or remove notes.txt before sending.",
    );
    await pane.getByRole("button", { name: "Retry notes.txt", exact: true }).click();
    await expect(chip).not.toContainText("Upload failed");
    await expect(chip).not.toContainText("%");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) => {
      expect(
        messageText(messages.findLast((message) => message.role === "user")!),
      ).toContain("coral raven");
      return m.assistant("A coral raven.");
    });
  },
);

e2eTest(
  "waits in the composer for a new session's first upload, then opens the session",
  async ({ app, llm }, testInfo) => {
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    const pane = app.page.getByRole("main");
    const chunks = await holdChunks(app.page);
    await pane.getByLabel("Message", { exact: true }).fill("Open this archive");
    await pane
      .getByLabel("Attach files", { exact: true })
      .setInputFiles(largeFile("first.bin"));
    await expect.poll(() => chunks.held.length).toBe(1);
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect(pane.getByRole("status")).toHaveText(
      "Uploading attachments… 0%",
    );
    await app.page.screenshot({
      path: testInfo.outputPath("new-session-uploading-desktop-1100x720.png"),
    });
    await chunks.release();
    await llm.respond(({ messages }) => {
      expect(
        messageText(messages.findLast((message) => message.role === "user")!),
      ).toContain("first.bin");
      return m.assistant("Opened.");
    });
    await expect(
      app.page.getByRole("main", { name: "Open this archive" }),
    ).toBeVisible();
  },
);

e2eTest(
  "cancels a removed attachment's upload and keeps the draft's attachments after its tab closes",
  async ({ app, harness, testArtifacts }) => {
    await harness.loadSession({
      title: "Remove upload",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const staging = path.join(testArtifacts.paths.workspace, ".halo", "uploads");
    const pane = app.page.getByRole("main", { name: "Remove upload" });
    const chunks = await holdChunks(app.page);
    await pane
      .getByLabel("Attach files", { exact: true })
      .setInputFiles(largeFile("removed.bin"));
    await expect.poll(() => chunks.held.length).toBe(1);
    await pane
      .getByRole("button", { name: "Remove removed.bin", exact: true })
      .click();
    await chunks.release();
    await expect.poll(async () => await fs.readdir(staging)).toEqual([]);
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "done.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("finished"),
    });
    await expect.poll(async () => (await fs.readdir(staging)).length).toBe(1);
    // Like the draft text, the draft's attachments survive closing the tab.
    await app.page
      .getByRole("button", { name: "Close Remove upload", exact: true })
      .click();
    await app.page
      .getByRole("link", { name: "Remove upload", exact: true })
      .click();
    const reopened = app.page.getByRole("main", { name: "Remove upload" });
    await expect(
      reopened.getByRole("list", { name: "Attachments", exact: true }),
    ).toContainText("done.txt");
    expect(await fs.readdir(staging)).toHaveLength(1);
    await reopened
      .getByRole("button", { name: "Remove done.txt", exact: true })
      .click();
    await expect.poll(async () => await fs.readdir(staging)).toEqual([]);
  },
);

e2eTest(
  "re-uploads the files of a sent queued message when it moves back to the draft",
  async ({ app, harness, llm }) => {
    await harness.loadSession({
      title: "Queued sent",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Queued sent" });
    const editor = pane.getByLabel("Message", { exact: true });
    await editor.fill("Start working");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.waitForRequest();
    await editor.fill("Queued with a file");
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "queued.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("scarlet robin"),
    });
    const chip = pane
      .getByRole("list", { name: "Attachments", exact: true })
      .getByRole("listitem");
    await expect(chip).not.toContainText("%");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    const withdraw = pane.getByRole("button", {
      name: "Move queued message to draft",
      exact: true,
    });
    await expect(withdraw).toBeEnabled();
    await withdraw.click();
    await expect(editor).toContainText("Queued with a file");
    await expect(chip).toContainText("queued.txt");
    await expect(chip).not.toContainText("%");
    await llm.respond(m.assistant("Initial work finished."));
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) => {
      expect(
        messageText(messages.findLast((message) => message.role === "user")!),
      ).toContain("scarlet robin");
      return m.assistant("Read it again.");
    });
  },
);

e2eTest(
  "keeps a new session's draft and its finished upload when the first message is rejected",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    const pane = app.page.getByRole("main");
    const editor = pane.getByLabel("Message", { exact: true });
    await editor.fill("Read my notes");
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("orange heron"),
    });
    const chip = pane
      .getByRole("list", { name: "Attachments", exact: true })
      .getByRole("listitem");
    await expect(chip).not.toContainText("%");
    let writes = 0;
    await app.page.route("**/rpc/uploads/write", async (route) => {
      writes++;
      await route.continue();
    });
    // The real server rejects an unknown upload ID.
    await app.page.route("**/rpc/thread/prompt", async (route) => {
      await route.continue({
        postData: route
          .request()
          .postData()!
          .replace(/"uploadIds":\["[^"]+"\]/, '"uploadIds":["missing"]'),
      });
    });
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect(pane.getByRole("alert")).toHaveText(
      "This upload no longer exists. Attach the file again.",
    );
    await expect(editor).toHaveText("Read my notes");
    await expect(chip).toContainText("notes.txt");
    await expect(chip).not.toContainText("%");
    await expect(chip).not.toContainText("Upload failed");
    await app.page.unroute("**/rpc/thread/prompt");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) => {
      expect(
        messageText(messages.findLast((message) => message.role === "user")!),
      ).toContain("orange heron");
      return m.assistant("An orange heron.");
    });
    // The resend used the upload that already finished.
    expect(writes).toBe(0);
  },
);

e2eTest(
  "returns a failed waiting message and the one behind it to the draft, in order",
  async ({ app, harness }) => {
    await harness.loadSession({
      title: "Cascade",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Cascade" });
    const editor = pane.getByLabel("Message", { exact: true });
    const chunks = await holdChunks(app.page);
    await editor.fill("A with a file");
    await pane
      .getByLabel("Attach files", { exact: true })
      .setInputFiles(largeFile("a.bin"));
    await expect.poll(() => chunks.held.length).toBe(1);
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await editor.fill("B without a file");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    const rows = pane.getByRole("article", { name: "You message" });
    await expect(rows.filter({ hasText: "B without a file" })).toBeVisible();
    const route = chunks.held.shift()!;
    const uploadId = /"uploadId":"([^"]+)"/.exec(route.request().postData()!)![1]!;
    await app.server.rpc.uploads.cancel({ uploadId });
    await chunks.release();
    await route.continue();
    await expect(pane.getByRole("alert")).toHaveText(
      "This upload no longer exists. Attach the file again.",
    );
    await expect(editor).toHaveText(/A with a file[\s\S]*B without a file/);
    // Neither message reached the session.
    await app.page.waitForTimeout(500);
    await expect(rows.filter({ hasText: "A with a file" })).toHaveCount(0);
    await expect(rows.filter({ hasText: "B without a file" })).toHaveCount(0);
  },
);

e2eTest(
  "keeps sending a waiting message after the tab shows another session",
  async ({ app, harness, llm }) => {
    await harness.loadSession({
      title: "Other session",
      messages: [m.user("Other"), m.assistant("Other reply.")],
    });
    await harness.loadSession({
      title: "Leave early",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Leave early" });
    const chunks = await holdChunks(app.page);
    await pane.getByLabel("Message", { exact: true }).fill("Send it anyway");
    await pane
      .getByLabel("Attach files", { exact: true })
      .setInputFiles(largeFile("leave.bin"));
    await expect.poll(() => chunks.held.length).toBe(1);
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect(pane).toContainText("Sends when its files finish uploading");
    await app.page
      .getByRole("link", { name: "Other session", exact: true })
      .click();
    await expect(
      app.page.getByRole("main", { name: "Other session" }),
    ).toBeVisible();
    await chunks.release();
    await llm.respond(({ messages }) => {
      expect(
        messageText(messages.findLast((message) => message.role === "user")!),
      ).toContain("leave.bin");
      return m.assistant("Sent after leaving.");
    });
    await app.page
      .getByRole("link", { name: "Leave early", exact: true })
      .click();
    await expect(
      app.page.getByRole("main", { name: "Leave early" }).getByRole("log"),
    ).toContainText("Sent after leaving.");
  },
);

e2eTest(
  "sends a new session's first message after its tab closes mid-send",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    const pane = app.page.getByRole("main");
    await pane.getByLabel("Message", { exact: true }).fill("Closing early");
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "kept.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("violet finch"),
    });
    await expect(
      pane.getByRole("list", { name: "Attachments", exact: true }),
    ).not.toContainText("%");
    const prompts: Route[] = [];
    await app.page.route("**/rpc/thread/prompt", (route) => {
      prompts.push(route);
    });
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => prompts.length).toBe(1);
    await app.page
      .getByRole("button", { name: /^Close (New session|Closing early)$/ })
      .last()
      .click();
    await prompts[0]!.continue();
    await llm.respond(({ messages }) => {
      expect(
        messageText(messages.findLast((message) => message.role === "user")!),
      ).toContain("violet finch");
      return m.assistant("Got the finch.");
    });
    await app.page.unroute("**/rpc/thread/prompt");
  },
);

e2eTest(
  "shows queued messages in send order and keeps waiting ones after Stop",
  async ({ app, harness, llm }) => {
    await harness.loadSession({
      title: "Stop and order",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Stop and order" });
    const editor = pane.getByLabel("Message", { exact: true });
    const rows = pane.getByRole("article", { name: "You message" });
    await editor.fill("Start working");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.waitForRequest();
    // A text message during the run is queued on the server at once.
    await editor.fill("A text first");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect(rows.filter({ hasText: "A text first" })).toBeVisible();
    const chunks = await holdChunks(app.page);
    await editor.fill("B with a file");
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "b.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("bravo"),
    });
    await expect.poll(() => chunks.held.length).toBe(1);
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await editor.fill("C with a file");
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "c.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("charlie"),
    });
    await expect.poll(() => chunks.held.length).toBe(2);
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    const texts = async () =>
      (await rows.allInnerTexts()).map((text) => text.split("\n")[0]);
    await expect.poll(texts).toEqual([
      "Hello",
      "Start working",
      "A text first",
      "B with a file",
      "C with a file",
    ]);
    // B's upload finishes, so it is sent and queued on the server; C waits.
    await chunks.held.shift()!.continue();
    await expect(
      rows.filter({ hasText: "B with a file" }),
    ).not.toContainText("Sends when its files finish uploading");
    await pane.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(rows.filter({ hasText: "A text first" })).toHaveCount(0);
    await expect(rows.filter({ hasText: "B with a file" })).toHaveCount(0);
    await expect(rows.filter({ hasText: "C with a file" })).toContainText(
      "Sends when its files finish uploading",
    );
    await chunks.release();
    await llm.respond(({ messages }) => {
      const users = messages
        .filter((message) => message.role === "user")
        .map(messageText);
      expect(users.join("\n")).not.toContain("bravo");
      expect(users.at(-1)).toContain("charlie");
      return m.assistant("Only C ran.");
    });
    await expect(pane.getByRole("log")).toContainText("Only C ran.");
  },
);
