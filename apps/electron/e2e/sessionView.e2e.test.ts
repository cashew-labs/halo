import { expect, type Route } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import fs from "node:fs/promises";
import path from "node:path";

e2eTest(
  "references files and sessions from a message",
  async ({ app, harness, llm }) => {
    await harness.loadSession({
      title: "Previous plan",
      messages: [
        m.user("What is the launch color?"),
        m.assistant("The launch color is indigo."),
      ],
    });
    await app.server.rpc.workspace.writeFile({
      path: "brief.md",
      content: "The release date is Friday.",
    });
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    const pane = app.page.getByRole("main", { name: "New session" });
    const editor = pane.getByLabel("Message", { exact: true });
    await editor.fill("Compare @brief");
    await pane.getByRole("option", { name: /brief.md/ }).click();
    await expect(pane.getByRole("list", { name: "References" })).toContainText(
      "brief.md",
    );
    await editor.pressSequentially(" with @Previous");
    await pane.getByRole("option", { name: /Previous plan/ }).click();
    await expect(pane.getByRole("list", { name: "References" })).toContainText(
      "Previous plan",
    );
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) => {
      const user = messages.findLast((message) => message.role === "user");
      expect(user).toBeDefined();
      expect(messageText(user!)).toContain('File: "brief.md"');
      expect(messageText(user!)).toContain("The launch color is indigo.");
      return m.assistant("I can compare those references.");
    });
    const sent = app.page.getByRole("article", { name: "You message" });
    await expect(sent.getByRole("list", { name: "References" })).toContainText(
      "brief.md",
    );
    await expect(sent.getByRole("list", { name: "References" })).toContainText(
      "Previous plan",
    );
    await sent.getByRole("link", { name: "Previous plan" }).click();
    await expect(
      app.page.getByRole("main", { name: "Previous plan" }),
    ).toBeVisible();
  },
);

// Chromium's nested PDF frame can stall Playwright DOM snapshot evaluation on
// macOS before an assertion starts. Keep screenshots and action logs without
// injecting snapshot scripts into the native PDF viewer for this test.
const attachmentTest = e2eTest.extend({ traceSnapshots: false });

attachmentTest(
  "drops images, PDFs, and Word files into chat and keeps their model context after reload",
  async ({ app, llm }, testInfo) => {
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    const pane = app.page.getByRole("main");
    const fixtures = await Promise.all(
      ["picture.png", "document.pdf", "document.docx"].map(async (name) => ({
        name,
        data: (
          await fs.readFile(
            path.resolve(
              import.meta.dirname,
              "../../../packages/workspace-server/test/fixtures/attachments",
              name,
            ),
          )
        ).toString("base64"),
      })),
    );
    const transfer = await app.page.evaluateHandle((files) => {
      const data = new DataTransfer();
      for (const file of files)
        data.items.add(
          new File(
            [Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0))],
            file.name,
          ),
        );
      return data;
    }, fixtures);
    const editor = pane.getByLabel("Message", { exact: true });
    await editor.fill("Summarize my attached files");
    await pane.dispatchEvent("dragenter", { dataTransfer: transfer });
    await expect(
      pane.getByText("Drop files to attach", { exact: true }),
    ).toBeVisible();
    await editor.dispatchEvent("dragover", { dataTransfer: transfer });
    await expect(
      pane.getByText("Drop files to attach", { exact: true }),
    ).toBeVisible();
    await app.page.screenshot({ path: testInfo.outputPath("file-drag.png") });
    await editor.dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();
    await expect(
      pane.getByText("Drop files to attach", { exact: true }),
    ).not.toBeVisible();
    const attachments = pane.getByRole("list", {
      name: "Attachments",
      exact: true,
    });
    for (const fixture of fixtures)
      await expect(
        attachments.getByText(fixture.name, { exact: true }),
      ).toBeVisible();
    await app.page.screenshot({
      path: testInfo.outputPath("attachments-ready.png"),
    });
    const uploads: Route[] = [];
    await app.page.route("**/rpc/thread/prompt", (route) => {
      uploads.push(route);
    });
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => uploads.length).toBe(1);
    await expect(
      pane.getByRole("button", { name: "Send", exact: true }),
    ).toBeDisabled();
    await expect(pane.getByRole("status")).toHaveText("Preparing attachments…");
    await expect(attachments.getByRole("listitem")).toHaveCount(3);
    await uploads[0]!.continue();
    await app.page.unroute("**/rpc/thread/prompt");
    await llm.respond(({ messages }) => {
      const user = messages.findLast((message) => message.role === "user");
      expect(user).toBeDefined();
      expect(messageText(user!)).toContain("scarlet robin");
      expect(messageText(user!)).toContain("orange heron");
      expect(
        Array.isArray(user!.content)
          ? user!.content.filter((part) => part.type === "image_url")
          : [],
      ).toHaveLength(4);
      return m.assistant(
        "The Word document says scarlet robin; the PDF says orange heron. I can see the image and both PDF pages.",
      );
    });
    const userMessage = pane.getByRole("article", { name: "You message" });
    await expect(userMessage).toContainText("Summarize my attached files");
    await expect(
      userMessage
        .getByRole("list", { name: "Attached files" })
        .getByRole("listitem"),
    ).toHaveCount(3);
    await expect(userMessage).not.toContainText("scarlet robin");
    await expect(pane.getByRole("log")).toContainText(
      "I can see the image and both PDF pages.",
    );
    const chatTabTitle = await app.page
      .getByRole("toolbar", { name: /^Pane \d+ tabs$/ })
      .getByRole("button", { pressed: true })
      .innerText();
    const chatTab = app.page
      .getByRole("toolbar", { name: /^Pane \d+ tabs$/ })
      .getByRole("button", { name: chatTabTitle, exact: true });
    const initialTabCount = await app.page
      .locator("[role=toolbar] button[aria-pressed]")
      .count();
    await editor.fill("Keep this follow-up draft");
    for (const [index, name] of [
      "picture.png",
      "document.pdf",
      "document.docx",
    ].entries()) {
      await userMessage.getByRole("link", { name, exact: true }).click();
      await expect(
        app.page.locator("[role=toolbar] button[aria-pressed]"),
      ).toHaveCount(initialTabCount + index + 1);
      await expect(
        app.page
          .getByRole("toolbar", { name: /^Pane \d+ tabs$/ })
          .getByRole("button", { pressed: true }),
      ).toHaveText(name);
      await expect(chatTab).toBeVisible();
      await chatTab.click();
      await expect(editor).toHaveText("Keep this follow-up draft");
      await expect(userMessage).toContainText("Summarize my attached files");
    }
    await userMessage
      .getByRole("link", { name: "picture.png", exact: true })
      .click();
    await expect(
      app.page.locator("[role=toolbar] button[aria-pressed]"),
    ).toHaveCount(initialTabCount + 3);
    await expect(
      app.page.getByRole("img", { name: /\/picture\.png$/ }),
    ).toBeVisible();
    await chatTab.click();
    await app.page.reload();
    await expect(
      userMessage.getByRole("link", { name: "document.docx", exact: true }),
    ).toBeVisible();
    await pane
      .getByLabel("Message", { exact: true })
      .fill("Recall those attachments");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) => {
      const context = messages.map(messageText).join("\n");
      expect(context).toContain("scarlet robin");
      expect(context).toContain("coral raven");
      return m.assistant("I still have the attached file contents.");
    });
    await expect(pane.getByRole("log")).toContainText(
      "I still have the attached file contents.",
    );
  },
);

e2eTest(
  "keeps rendering a long session while a response streams faster than it renders",
  async ({ app, harness, llm }) => {
    e2eTest.setTimeout(120_000);
    const pageErrors: string[] = [];
    app.page.on("pageerror", (error) =>
      pageErrors.push(error.stack ?? error.message),
    );
    await harness.loadSession({
      title: "Long conversation",
      messages: Array.from({ length: 400 }, (_, index) => [
        m.user(`Question ${index}: Please explain step ${index} in detail.`),
        m.assistant(
          [
            `## Answer ${index}`,
            "",
            `Step ${index} has a detailed explanation with \`code\` and a list:`,
            "",
            "- first point",
            "- second point",
            "",
            "| Column | Value |",
            "| --- | --- |",
            `| step | ${index} |`,
            "",
            "```ts",
            `const step = ${index};`,
            "```",
          ].join("\n"),
        ),
      ]).flat(),
    });
    const session = app.page.getByRole("main", { name: "Long conversation" });
    const transcript = session.getByRole("log", { name: "Session transcript" });
    await expect(transcript).toContainText("Answer 399");

    // Keep renderer work slower than incoming deltas on fast CI machines.
    const cdp = await app.page.context().newCDPSession(app.page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

    await session.getByLabel("Message", { exact: true }).fill("Keep going");
    await session.getByRole("button", { name: "Send", exact: true }).click();
    const response = await llm.stream();
    // Each delta re-renders the whole transcript. Deltas that arrive faster
    // than that render once made React count the Find updates as nested and
    // unmount the window with "Maximum update depth exceeded".
    for (let index = 0; index < 2_000; index++) {
      response.write(m.assistant(`token-${index} `));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    response.end();
    await expect
      .poll(
        async () =>
          pageErrors[0] ??
          (await transcript.textContent())?.includes("token-1999"),
        { timeout: 60_000 },
      )
      .toBe(true);
    expect(pageErrors).toEqual([]);
    await expect(transcript).toContainText("Answer 399");
  },
);

e2eTest("starts a new session", async ({ harness, app }) => {
  await harness.loadSession({
    title: "Existing conversation",
    messages: [
      m.user("Summarize this workspace"),
      m.assistant("Here is the summary."),
    ],
  });

  await app.page.getByRole("button", { name: "New tab", exact: true }).click();

  const newSession = app.page.getByRole("main", {
    name: "New session",
    exact: true,
  });
  await expect(newSession).toBeVisible();
  await expect(newSession.getByLabel("Message", { exact: true })).toBeFocused();
});

e2eTest(
  "continues with saved messages and tool results after quitting Halo",
  async ({ app, harness, llm }) => {
    await harness.tools.files.write({
      path: "notes.md",
      content: "The project mascot is a blue bicycle.",
    });
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Read the project notes");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond([
      m.assistant("I will read the notes."),
      m.tool.start("read", {
        id: "read-notes",
        arguments: { path: "notes.md" },
      }),
    ]);
    await llm.respond(m.assistant("The notes are saved."));
    await expect(app.page.getByRole("main")).toContainText(
      "The notes are saved.",
    );
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).not.toBeVisible();

    await app.quit();
    await app.open();

    const pane = app.page.getByRole("main");
    const transcript = pane.getByRole("log", { name: "Session transcript" });
    await expect(
      transcript.getByText("Read the project notes", { exact: true }),
    ).toBeVisible();
    await expect(
      transcript.getByText("The notes are saved.", {
        exact: true,
      }),
    ).toBeVisible();

    await pane
      .getByLabel("Message", { exact: true })
      .fill("Continue the conversation");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) =>
      m.assistant(
        [
          `Earlier prompts: ${messages
            .filter((message) => message.role === "user")
            .map((message) => messageText(message))
            .join(" → ")}`,
          `Earlier answers: ${messages
            .filter((message) => message.role === "assistant")
            .map((message) => messageText(message))
            .join(" → ")}`,
          `Earlier tool results: ${messages
            .filter((message) => message.role === "tool")
            .map((message) => messageText(message))
            .join("\n")}`,
        ].join("\n\n"),
      ),
    );
    await expect(
      transcript.getByText(
        "Earlier prompts: Read the project notes → Continue the conversation",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      transcript.getByText(
        "Earlier answers: I will read the notes. → The notes are saved.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      transcript.getByText(
        "Earlier tool results: The project mascot is a blue bicycle.",
        { exact: true },
      ),
    ).toBeVisible();
  },
);

e2eTest(
  "finishes a pending response while Electron is closed",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Start an answer");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      app.page.getByRole("article", { name: "You message" }),
    ).toContainText("Start an answer");

    await llm.waitForRequest();
    await app.quit();
    await llm.respond(
      m.assistant("The server finished while Electron was closed."),
    );
    await app.open();

    await expect(app.page.getByRole("main")).toContainText(
      "The server finished while Electron was closed.",
    );
  },
);

e2eTest(
  "restores partial assistant text on reload and continues the same response",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Explain the plan");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const response = await llm.stream();
    response.write(m.assistant("The first step"));
    await expect(
      app.page.getByRole("log", { name: "Session transcript" }),
    ).toContainText("The first step");

    await app.page.reload();

    const transcript = app.page.getByRole("log", {
      name: "Session transcript",
    });
    await expect(transcript).toContainText("The first step");
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    response.write(m.assistant(" is to save the notes."));
    response.end();
    await expect(
      transcript.getByText("The first step is to save the notes.", {
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).not.toBeVisible();
  },
);
