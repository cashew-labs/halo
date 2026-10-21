import fs from "node:fs/promises";
import path from "node:path";
import { expect, type Route } from "@playwright/test";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import { e2eTest } from "../e2eTest.js";

e2eTest(
  "uploads attachments in chunks with progress before sending them",
  async ({ app, harness, llm }) => {
    await harness.loadSession({
      title: "Upload progress",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Upload progress" });
    await pane.getByLabel("Message", { exact: true }).fill("Read my notes");
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("The bird is a scarlet robin."),
    });
    const writes: Route[] = [];
    await app.page.route("**/rpc/uploads/write", (route) => {
      writes.push(route);
    });
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(pane.getByRole("status")).toHaveText(
      "Uploading attachments… 0%",
    );
    await writes[0]!.continue();
    await app.page.unroute("**/rpc/uploads/write");
    await llm.respond(({ messages }) => {
      expect(
        messageText(messages.findLast((message) => message.role === "user")!),
      ).toContain("The bird is a scarlet robin.");
      return m.assistant("It is a scarlet robin.");
    });
    const sent = pane
      .getByRole("article", { name: "You message" })
      .filter({ hasText: "Read my notes" });
    await expect(
      sent.getByRole("list", { name: "Attached files" }).getByRole("link", {
        name: "notes.txt",
      }),
    ).toBeVisible();
  },
);

e2eTest(
  "keeps the draft when an upload or the message fails, then sends it",
  async ({ app, llm, testArtifacts }) => {
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    const pane = app.page.getByRole("main");
    const editor = pane.getByLabel("Message", { exact: true });
    await editor.fill("Summarize notes");
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("coral raven"),
    });
    // Cancelling the upload on the server while its first chunk is held makes
    // the server reject it. An aborted request would show the connection
    // banner instead of the error.
    await app.page.route("**/rpc/uploads/write", async (route) => {
      const uploadId = /"uploadId":"([^"]+)"/.exec(
        route.request().postData()!,
      )![1]!;
      await app.server.rpc.uploads.cancel({ uploadId });
      await route.continue();
    });
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect(pane.getByRole("alert")).toHaveText(
      "This upload no longer exists. Attach the file again.",
    );
    await expect(editor).toHaveText("Summarize notes");
    await expect(
      pane
        .getByRole("list", { name: "Attachments", exact: true })
        .getByText("notes.txt"),
    ).toBeVisible();
    await app.page.unroute("**/rpc/uploads/write");

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
    await expect(editor).toHaveText("Summarize notes");
    // The failed message cancelled its finished upload.
    const staging = path.join(testArtifacts.paths.workspace, ".halo", "uploads");
    await expect.poll(async () => await fs.readdir(staging)).toEqual([]);
    await app.page.unroute("**/rpc/thread/prompt");

    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) => {
      expect(
        messageText(messages.findLast((message) => message.role === "user")!),
      ).toContain("coral raven");
      return m.assistant("A coral raven.");
    });
    await expect(
      app.page.getByRole("main", { name: "Summarize notes" }),
    ).toBeVisible();
  },
);

e2eTest(
  "stops uploading and does not send when the chat tab closes",
  async ({ app, testArtifacts }) => {
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    const pane = app.page.getByRole("main");
    await pane.getByLabel("Message", { exact: true }).fill("Never sent");
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "large.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(9 * 1024 * 1024, 1),
    });
    const writes: Route[] = [];
    await app.page.route("**/rpc/uploads/write", async (route) => {
      writes.push(route);
      // Hold the first chunk; let any later request through so it is counted.
      if (writes.length > 1) await route.continue();
    });
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    await app.page
      .getByRole("button", { name: "Close New session", exact: true })
      .last()
      .click();
    await writes[0]!.continue();
    // Give a second chunk and the prompt time to run if the upload continued.
    await app.page.waitForTimeout(1500);
    expect(writes).toHaveLength(1);
    expect(await app.server.rpc.thread.list()).toEqual([]);
    const staging = path.join(testArtifacts.paths.workspace, ".halo", "uploads");
    await expect.poll(async () => await fs.readdir(staging)).toEqual([]);
    await app.page.unroute("**/rpc/uploads/write");
  },
);

e2eTest(
  "uploads a queued message's files and restores them when it is withdrawn",
  async ({ app, harness, llm }) => {
    await harness.loadSession({
      title: "Queued upload",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Queued upload" });
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
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    const withdraw = pane.getByRole("button", {
      name: "Move queued message to draft",
      exact: true,
    });
    await expect(withdraw).toBeEnabled();
    await withdraw.click();
    await expect(editor).toContainText("Queued with a file");
    await expect(
      pane
        .getByRole("list", { name: "Attachments", exact: true })
        .getByText("queued.txt"),
    ).toBeVisible();
    await llm.respond(m.assistant("Initial work finished."));
  },
);
