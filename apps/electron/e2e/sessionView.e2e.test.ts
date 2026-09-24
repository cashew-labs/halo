import { expect, type Route } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import fs from "node:fs/promises";
import path from "node:path";

e2eTest(
  "drops images, PDFs, and Word files into chat and keeps their model context after reload",
  async ({ app, llm }, testInfo) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
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
    await app.page.route("**/rpc/sessions/prompt", (route) => {
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
    await app.page.unroute("**/rpc/sessions/prompt");
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
    const chatTabId = await app.page
      .getByRole("tab", { selected: true })
      .getAttribute("id");
    expect(chatTabId).not.toBeNull();
    const chatTab = app.page.locator(`#${chatTabId}`);
    const initialTabCount = await app.page.getByRole("tab").count();
    await editor.fill("Keep this follow-up draft");
    for (const [index, name] of [
      "picture.png",
      "document.pdf",
      "document.docx",
    ].entries()) {
      await userMessage.getByRole("link", { name, exact: true }).click();
      await expect(app.page.getByRole("tab")).toHaveCount(
        initialTabCount + index + 1,
      );
      await expect(app.page.getByRole("tab", { selected: true })).toHaveText(
        name,
      );
      await expect(chatTab).toBeVisible();
      await chatTab.click();
      await expect(editor).toHaveText("Keep this follow-up draft");
      await expect(userMessage).toContainText("Summarize my attached files");
    }
    await userMessage
      .getByRole("link", { name: "picture.png", exact: true })
      .click();
    await expect(app.page.getByRole("tab")).toHaveCount(initialTabCount + 3);
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
  "chooses spreadsheets and presentations in an existing chat and removes individual duplicate filenames",
  async ({ app, harness, llm }) => {
    await harness.loadSession({
      title: "Review the files",
      messages: [m.user("Review the files"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main");
    const files = await Promise.all(
      ["workbook.xlsx", "slides.pptx"].map(async (name) => ({
        name,
        mimeType: "application/octet-stream",
        buffer: await fs.readFile(
          path.resolve(
            import.meta.dirname,
            "../../../packages/workspace-server/test/fixtures/attachments",
            name,
          ),
        ),
      })),
    );
    const chooser = app.page.waitForEvent("filechooser");
    await pane
      .getByRole("button", { name: "Add attachments", exact: true })
      .click();
    await (
      await chooser
    ).setFiles([
      ...files,
      {
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("REMOVE THIS NOTE"),
      },
      {
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("KEEP THIS NOTE"),
      },
    ]);
    const attachments = pane.getByRole("list", {
      name: "Attachments",
      exact: true,
    });
    await expect(attachments.getByRole("listitem")).toHaveCount(4);
    await attachments
      .getByRole("button", { name: "Remove notes.txt", exact: true })
      .first()
      .click();
    await expect(attachments.getByRole("listitem")).toHaveCount(3);
    await expect(pane.getByLabel("Message", { exact: true })).toHaveText("");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.waitForRequest();
    await expect(
      pane.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    await pane
      .getByLabel("Message", { exact: true })
      .fill("Draft while the model answers");
    await llm.respond(({ messages }) => {
      const user = messages.findLast((message) => message.role === "user");
      expect(user).toBeDefined();
      const context = messageText(user!);
      for (const marker of [
        "indigo jay",
        "pearl dove",
        "turquoise crane",
        "olive wren",
        "KEEP THIS NOTE",
      ])
        expect(context).toContain(marker);
      expect(context).not.toContain("REMOVE THIS NOTE");
      return m.assistant(
        "I can read both sheets, the slide, its notes, and the remaining text file.",
      );
    });
    await expect(pane.getByRole("log")).toContainText("I can read both sheets");
    await expect(
      app.page.getByRole("status", { name: "Agent is working", exact: true }),
    ).not.toBeVisible();
    await expect(pane.getByLabel("Message", { exact: true })).toHaveText(
      "Draft while the model answers",
    );
    await expect(
      pane
        .getByRole("article", { name: "You message" })
        .last()
        .getByRole("link"),
    ).toHaveCount(3);
    await expect(app.page.getByRole("tab", { selected: true })).toHaveText(
      "Review the files",
    );
  },
);

e2eTest(
  "preserves the draft and files after an attachment error and sends a corrected selection",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const pane = app.page.getByRole("main");
    await pane
      .getByLabel("Message", { exact: true })
      .fill("Please read my document");
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "broken.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("This is not a valid PDF"),
    });
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect(pane.getByRole("alert")).toContainText(
      "PDF could not be read",
    );
    await expect(pane.getByLabel("Message", { exact: true })).toHaveText(
      "Please read my document",
    );
    await expect(
      pane.getByRole("button", { name: "Remove broken.pdf", exact: true }),
    ).toBeEnabled();
    await expect(
      pane.getByRole("article", { name: "You message" }),
    ).toHaveCount(0);
    await pane
      .getByRole("button", { name: "Remove broken.pdf", exact: true })
      .click();
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "corrected.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("The corrected document says violet deer."),
    });
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) => {
      const user = messages.findLast((message) => message.role === "user");
      expect(messageText(user!)).toContain("violet deer");
      return m.assistant("I can read the corrected document.");
    });
    await expect(pane.getByRole("log")).toContainText(
      "I can read the corrected document.",
    );
    await expect(pane.getByRole("alert")).not.toBeVisible();
  },
);

e2eTest(
  "pastes an image into a new attachment-only chat",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const pane = app.page.getByRole("main");
    const image = await fs.readFile(
      path.resolve(
        import.meta.dirname,
        "../../../packages/workspace-server/test/fixtures/attachments/picture.png",
      ),
    );
    await pane
      .getByLabel("Message", { exact: true })
      .evaluate((element, base64) => {
        const data = new DataTransfer();
        data.items.add(
          new File(
            [Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))],
            "clipboard.png",
            { type: "image/png" },
          ),
        );
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, image.toString("base64"));
    await expect(
      pane.getByRole("button", { name: "Remove clipboard.png", exact: true }),
    ).toBeVisible();
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) => {
      const user = messages.findLast((message) => message.role === "user");
      expect(
        Array.isArray(user?.content)
          ? user.content.filter((part) => part.type === "image_url")
          : [],
      ).toHaveLength(1);
      return m.assistant("I received your pasted image.");
    });
    await expect(pane.getByRole("log")).toContainText(
      "I received your pasted image.",
    );
    await expect(app.page.getByRole("tab", { selected: true })).toHaveText(
      "clipboard.png",
    );
    await expect(
      pane
        .getByRole("article", { name: "You message" })
        .getByRole("link", { name: "clipboard.png", exact: true }),
    ).toBeVisible();
  },
);

e2eTest(
  "keeps the first message visible while the saved session reconnects",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const subscriptions: Route[] = [];
    await app.page.route("**/rpc/sessions/watch", async (route) => {
      subscriptions.push(route);
      if (subscriptions.length === 2) return;
      await route.continue();
    });

    const prompt = "Keep this message on screen";
    const observed = await app.page.evaluateHandle((text) => {
      const counts: number[] = [];
      const observer = new MutationObserver(() => {
        const count = [
          ...document.querySelectorAll('article[aria-label="You message"]'),
        ].filter((element) => element.textContent === text).length;
        if (count > 0 || counts.length > 0) counts.push(count);
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      return { counts, observer };
    }, prompt);
    const pane = app.page.getByRole("main");
    await pane.getByLabel("Message", { exact: true }).fill(prompt);
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => subscriptions.length).toBe(2);

    const message = pane.getByRole("article", { name: "You message" });
    await expect(message).toHaveText(prompt);
    await expect(message).toBeVisible();
    await expect(
      pane.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    await subscriptions[1]!.continue();
    await llm.respond(m.assistant("The message stayed visible."));
    await expect(
      pane.getByRole("log", { name: "Session transcript" }),
    ).toContainText("The message stayed visible.");
    await expect(message).toHaveCount(1);
    const observedCounts = await observed.evaluate(({ counts, observer }) => {
      observer.disconnect();
      return counts;
    });
    expect(observedCounts.length).toBeGreaterThan(0);
    expect(observedCounts.every((count) => count === 1)).toBe(true);
    await observed.dispose();
  },
);

e2eTest(
  "preserves the reading position during streaming and follows again at the bottom",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Explain the plan");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const transcript = app.page.getByRole("log", {
      name: "Session transcript",
    });
    const lastStep = transcript.getByText("Plan step 50.", { exact: true });
    const response = await llm.stream();
    response.write(
      m.assistant(
        Array.from({ length: 50 }, (_, i) => `Plan step ${i + 1}.`).join(
          "\n\n",
        ),
      ),
    );
    await expect(transcript).toContainText("Plan step 50.");
    await expect(lastStep).toBeInViewport();

    await transcript.hover();
    await app.page.mouse.wheel(0, -400);
    await expect(lastStep).not.toBeInViewport();

    for (const chunk of ["More details.", "Another update."]) {
      response.write(m.assistant(`\n\n${chunk}`));
      await expect(transcript).toContainText(chunk);
      await expect(lastStep).not.toBeInViewport();
    }

    await app.page.mouse.wheel(0, 10_000);
    await expect(lastStep).toBeInViewport();
    response.write(m.assistant("\n\nThe final step.\n\nThe plan is ready."));
    const finalStep = transcript.getByText("The plan is ready.", {
      exact: true,
    });
    await expect(finalStep).toBeInViewport();
    response.end();
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).not.toBeVisible();
    await expect(finalStep).toBeInViewport();
  },
);

e2eTest(
  "opens another session at the bottom after reading older messages",
  async ({ app, harness }) => {
    for (const title of [
      "First long conversation",
      "Second long conversation",
    ]) {
      await harness.loadSession({
        title,
        messages: [
          m.user(title),
          m.assistant(
            Array.from({ length: 50 }, (_, i) => `Saved step ${i + 1}.`).join(
              "\n\n",
            ),
          ),
        ],
      });
    }
    const transcript = app.page.getByRole("log", {
      name: "Session transcript",
    });
    const lastStep = transcript.getByText("Saved step 50.", { exact: true });
    await expect(lastStep).toBeInViewport();
    await transcript.hover();
    await app.page.mouse.wheel(0, -400);
    await expect(lastStep).not.toBeInViewport();

    const sidebar = app.page.getByRole("navigation", { name: "Workspace" });
    const firstSession = sidebar.getByRole("link", {
      name: "First long conversation",
      exact: true,
    });
    await expect(firstSession).toBeVisible();
    await expect(
      sidebar.getByRole("link", {
        name: "Second long conversation",
        exact: true,
      }),
    ).toBeVisible();
    await firstSession.click();
    await expect(transcript).toContainText("First long conversation");
    await expect(lastStep).toBeInViewport();
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

  await app.page
    .getByRole("button", { name: "New session", exact: true })
    .click();

  const newSession = app.page.getByRole("main", {
    name: "New session",
    exact: true,
  });
  await expect(newSession).toBeVisible();
  await expect(newSession.getByLabel("Message", { exact: true })).toBeFocused();
});

e2eTest(
  "keeps the selected session and draft pages after reload",
  async ({ harness, app }) => {
    for (const title of ["Earlier conversation", "Latest conversation"]) {
      await harness.loadSession({
        title,
        messages: [m.user(title), m.assistant("Saved reply")],
      });
    }
    await app.page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: "Earlier conversation", exact: true })
      .click();
    await app.page.reload();
    await expect(
      app.page.getByRole("main", { name: "Earlier conversation" }),
    ).toBeVisible();

    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const draft = app.page.getByRole("main", {
      name: "New session",
      exact: true,
    });
    await expect(draft).toBeVisible();
    await app.page.reload();
    await expect(draft).toBeVisible();
  },
);

e2eTest(
  "continues with saved messages and tool results after quitting Halo",
  async ({ app, harness, llm }) => {
    await harness.tools.files.write({
      path: "notes.md",
      content: "The project mascot is a blue bicycle.",
    });
    await app.page
      .getByRole("button", { name: "New session", exact: true })
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
  "answers a new message after stopping a pending model response",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Start a long answer");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();

    await app.page.getByRole("button", { name: "Stop", exact: true }).click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Answer this instead");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(m.assistant("Here is the new answer."));

    await expect(app.page.getByRole("main")).toContainText(
      "Here is the new answer.",
    );
  },
);

e2eTest(
  "finishes a pending response while Electron is closed",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
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
  "titles a session immediately and keeps its first message when inference is denied",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const pane = app.page.getByRole("main");
    const observed = await app.page.evaluateHandle(() => {
      const titles: string[] = [];
      const observer = new MutationObserver(() => {
        const title = document.querySelector(
          '[role="tab"][aria-selected="true"]',
        )?.textContent;
        if (title !== undefined && title !== null) titles.push(title);
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      return { titles, observer };
    });
    await pane
      .getByLabel("Message", { exact: true })
      .fill("Keep my original question");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect(app.page.getByRole("tab", { selected: true })).toHaveText(
      "Keep my original question",
    );
    await llm.respond(m.error("Model access denied"));

    await expect(pane.getByRole("alert")).toContainText("Model access denied");
    await expect(
      pane.getByRole("article", { name: "You message" }),
    ).toContainText("Keep my original question");

    await pane.getByLabel("Message", { exact: true }).fill("Try again");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(m.assistant("Ready to continue."));

    await expect(
      pane.getByRole("log", { name: "Session transcript" }),
    ).toContainText("Ready to continue.");
    await expect(pane.getByRole("alert")).not.toBeVisible();
    await expect(app.page.getByRole("tab", { selected: true })).toHaveText(
      "Keep my original question",
    );
    const [session] = await app.server.rpc.sessions.list();
    expect(session).toBeDefined();
    const observedTitles = await observed.evaluate(({ titles, observer }) => {
      observer.disconnect();
      return titles;
    });
    await observed.dispose();
    expect(observedTitles).toContain("Keep my original question");
    expect(observedTitles).not.toContain(session!.sessionId);
  },
);

const googleDriveConnection = {
  client: "first-party:google",
  clientOwner: "org",
  owner: "user",
  connectionName: "default",
  integration: "google_drive",
  template: "googleOAuth2",
} as const;

e2eTest("shows a connection request", async ({ harness, app }) => {
  await harness.loadSession({
    title: "Drive search",
    messages: [
      m.user("Find my planning document"),
      m.connectionRequest(googleDriveConnection),
    ],
  });

  const card = app.page.getByRole("region", {
    name: "Google Drive connection",
  });
  await expect(card).toBeVisible();
  await expect(
    card.getByText("Search, read, create, and share files."),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Connect" })).toBeVisible();
  await expect(
    card.getByText("Connect your account so the agent can continue"),
  ).toHaveCount(0);
});

e2eTest(
  "starts connecting a tool from the connection card",
  async ({ harness, app }) => {
    await harness.loadSession({
      title: "Drive search",
      messages: [
        m.user("Find my planning document"),
        m.connectionRequest(googleDriveConnection),
      ],
    });

    const card = app.page.getByRole("region", {
      name: "Google Drive connection",
    });
    await expect(
      card.getByText("Search, read, create, and share files."),
    ).toBeVisible();
    await card.getByRole("button", { name: "Connect" }).click();
    await expect(card.getByText("Opened in your browser")).toBeVisible();
    await expect(
      card.getByText("Search, read, create, and share files."),
    ).toBeVisible();
    await card.getByRole("button", { name: "Google Drive actions" }).click();
    await app.page.getByRole("menuitem", { name: "Cancel" }).click();
    await expect(card.getByText("Cancelled", { exact: true })).toBeVisible();
  },
);

e2eTest("shows tools used inside exec", async ({ harness, app }) => {
  const descriptionJs =
    "return await tools.describe.tool({ path: 'google_calendar.events.list' })";
  const searchJs = "return await tools.search({ query: 'web search' })";
  const lookupJs =
    "await Promise.all([tools.google_calendar.events.list({}), tools.web.search({ query: 'Halo' })])";
  await harness.loadSession({
    title: "Cross-tool lookup",
    messages: [
      m.user("Check my calendar and search the web"),
      m.exec({
        js: descriptionJs,
        tools: [{ path: "describe.tool" }],
        result: "Calendar tool schema",
      }),
      m.exec({
        js: searchJs,
        tools: [{ path: "search" }],
        result: "Web search tools found",
      }),
      m.exec({
        js: lookupJs,
        tools: [
          { path: "google_calendar.events.list" },
          { path: "web.search" },
        ],
        result: "Done",
      }),
    ],
  });

  const summary = app.page.getByRole("button", {
    name: "Searched tools and used Google Calendar, Web Search",
    exact: true,
  });
  await expect(summary).toBeVisible();
  await summary.click();
  await expect(
    app.page.getByText("Searched tools", { exact: true }),
  ).toHaveCount(2);
  await expect(
    app.page.getByText("Used Google Calendar", { exact: true }),
  ).toHaveCount(1);
  await expect(
    app.page.getByText("Used Web Search", { exact: true }),
  ).toHaveCount(1);
  await expect(app.page.getByText("Exec", { exact: true })).toHaveCount(0);
  for (const tool of [
    {
      path: "describe.tool",
      label: "Searched tools",
      js: descriptionJs,
      result: "Calendar tool schema",
    },
    {
      path: "search",
      label: "Searched tools",
      js: searchJs,
      result: "Web search tools found",
    },
    {
      path: "google_calendar.events.list",
      label: "Used Google Calendar",
      js: lookupJs,
      result: "Done",
    },
    {
      path: "web.search",
      label: "Used Web Search",
      js: lookupJs,
      result: "Done",
    },
  ]) {
    const call = app.page.getByRole("button", {
      name: `${tool.label} (${tool.path})`,
      exact: true,
    });
    await call.click();
    const details = app.page.getByRole("region", {
      name: tool.path,
      exact: true,
    });
    await expect(details.getByRole("code")).toHaveText([tool.js, tool.result]);
    await call.click();
  }
});

e2eTest(
  "restores nested tool activity while exec runs and after quitting",
  async ({ harness, app, llm, http }) => {
    await harness.tools.files.write({
      path: "notes.md",
      content: "Read before the request",
    });
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Read the notes and fetch the report");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const command = `curl --silent --fail '${http.url("/report")}'`;
    const js = `await tools.files.read({ path: "notes.md" }); return await tools.bash.run({ command: ${JSON.stringify(command)}, timeoutMs: 60000 });`;
    await llm.respond(
      m.tool.start("exec", { id: "report", arguments: { js } }),
    );
    const request = await http.request("/report");
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();

    await app.page.reload();

    const pane = app.page.getByRole("main");
    const summary = pane.getByRole("button", {
      name: "Read 1 file",
      exact: true,
    });
    await expect(summary).toBeVisible();
    await expect(
      summary.getByRole("status", { name: "Working" }),
    ).toBeVisible();
    await expect(
      summary.getByRole("img", { name: "Expand tool activity" }),
    ).toBeHidden();
    await expect(
      pane.getByLabel("Active tools").getByText(`$ ${command}`, {
        exact: true,
      }),
    ).toBeVisible();
    await summary.hover();
    await expect(
      summary.getByRole("img", { name: "Expand tool activity" }),
    ).toBeVisible();
    await expect(summary.getByRole("status", { name: "Working" })).toBeHidden();
    await expect(
      pane.getByLabel("Active tools").getByText(`$ ${command}`, {
        exact: true,
      }),
    ).toBeVisible();
    await summary.click();
    await expect(pane.getByLabel("Active tools")).toHaveCount(0);
    await expect(
      pane.getByRole("button", {
        name: "Read notes.md (files.read)",
        exact: true,
      }),
    ).toBeVisible();
    const running = pane.getByRole("button", {
      name: `${command} (bash.run)`,
      exact: true,
    });
    await expect(running).toBeVisible();
    await expect(pane.getByText(`$ ${command}`, { exact: true })).toHaveCount(
      1,
    );
    await running.click();
    await expect(
      pane
        .getByRole("region", { name: "bash.run", exact: true })
        .getByRole("code"),
    ).toHaveText(js);

    request.respond("The report is ready.");
    await llm.respond(m.assistant("Finished the report."));
    await expect(
      pane.getByText("Finished the report.", { exact: true }),
    ).toBeVisible();
    await expect(
      pane.getByRole("button", { name: "Stop", exact: true }),
    ).not.toBeVisible();
    await app.quit();
    await app.open();

    const restored = app.page.getByRole("main");
    await expect(
      restored.getByRole("button", {
        name: "Ran 1 command and read 1 file",
        exact: true,
      }),
    ).toBeVisible();
    await expect(restored.getByLabel("Active tools")).toHaveCount(0);
    await restored
      .getByRole("button", {
        name: "Ran 1 command and read 1 file",
        exact: true,
      })
      .click();
    await expect(
      restored.getByRole("button", {
        name: "Read notes.md (files.read)",
        exact: true,
      }),
    ).toBeVisible();
    await restored
      .getByRole("button", { name: `${command} (bash.run)`, exact: true })
      .click();
    await expect(
      restored.getByRole("region", { name: "bash.run", exact: true }),
    ).toContainText("The report is ready.");
  },
);

e2eTest(
  "keeps tool details expanded through exec progress and assistant streaming",
  async ({ app, llm, http }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Fetch both reports and summarize them");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const firstCommand = `curl --silent --fail '${http.url("/first")}'`;
    const secondCommand = `curl --silent --fail '${http.url("/second")}'`;
    const js = `await tools.bash.run({ command: ${JSON.stringify(firstCommand)}, timeoutMs: 60000 }); return await tools.bash.run({ command: ${JSON.stringify(secondCommand)}, timeoutMs: 60000 });`;
    await llm.respond(
      m.tool.start("exec", { id: "reports", arguments: { js } }),
    );
    const first = await http.request("/first");
    const pane = app.page.getByRole("main");
    await pane.getByRole("button", { name: "Working", exact: true }).click();
    const call = pane.getByRole("button", {
      name: `${firstCommand} (bash.run)`,
      exact: true,
    });
    await call.click();
    const details = pane.getByRole("region", {
      name: "bash.run",
      exact: true,
    });
    await expect(details.getByRole("code")).toHaveText(js);

    first.respond("First report");
    const second = await http.request("/second");
    await expect(
      pane.getByRole("button", {
        name: `${secondCommand} (bash.run)`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(call).toHaveAttribute("aria-expanded", "true");
    await expect(details).toBeVisible();

    second.respond("Second report");
    const verificationCommand = `curl --silent --fail '${http.url("/verify")}'`;
    await llm.respond(
      m.tool.start("bash", {
        id: "verification",
        arguments: { command: verificationCommand, timeoutMs: 60_000 },
      }),
    );
    const verification = await http.request("/verify");
    await expect(
      pane.getByRole("button", {
        name: `${verificationCommand} (bash)`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(call).toHaveAttribute("aria-expanded", "true");
    await expect(details).toContainText("Second report");

    verification.respond("Verified");
    const response = await llm.stream();
    response.write(m.assistant("Both reports"));
    await expect(pane.getByText("Both reports", { exact: true })).toBeVisible();
    await expect(call).toHaveAttribute("aria-expanded", "true");
    await expect(details).toBeVisible();

    response.write(m.assistant(" are ready."));
    response.end();
    await expect(
      pane.getByText("Both reports are ready.", { exact: true }),
    ).toBeVisible();
    await expect(
      pane.getByRole("button", { name: "Stop", exact: true }),
    ).not.toBeVisible();
    await expect(call).toHaveAttribute("aria-expanded", "true");
    await expect(details).toContainText("Second report");
  },
);

const expansionScenarios: {
  name: string;
  path: string;
  nested: boolean;
  args: Record<string, string>;
  active: string;
  completed: string;
  aggregate: string;
  result: string;
}[] = [
  {
    name: "nested integration",
    path: "google_calendar.events.list",
    nested: true,
    args: { calendarId: "primary" },
    active: "Using Google Calendar",
    completed: "Used Google Calendar",
    aggregate: "Used Google Calendar",
    result: "Team planning at 10 AM",
  },
  {
    name: "tool discovery",
    path: "search",
    nested: true,
    args: { query: "calendar" },
    active: "Searching tools",
    completed: "Searched tools",
    aggregate: "Searched tools",
    result: "Found google_calendar.events.list",
  },
  {
    name: "direct file",
    path: "read",
    nested: false,
    args: { path: "notes.md" },
    active: "Reading notes.md",
    completed: "Read notes.md",
    aggregate: "Read 1 file",
    result: "Project notes from the workspace",
  },
];

for (const scenario of expansionScenarios) {
  e2eTest(
    `expands saved ${scenario.name} tool details after reload`,
    async ({ harness, app }) => {
      const js = `return await tools.${scenario.path}(${JSON.stringify(scenario.args)});`;
      await harness.loadSession({
        title: "Expandable tools",
        messages: [
          m.user("Show the result"),
          scenario.nested
            ? m.exec({
                js,
                tools: [{ path: scenario.path, arguments: scenario.args }],
                result: scenario.result,
              })
            : {
                type: "tool",
                name: scenario.path,
                arguments: scenario.args,
                result: scenario.result,
              },
        ],
      });
      const pane = app.page.getByRole("main", { name: "Expandable tools" });
      await app.page.reload();
      await pane
        .getByRole("button", { name: scenario.aggregate, exact: true })
        .click();
      const call = pane.getByRole("button", {
        name: `${scenario.completed} (${scenario.path})`,
        exact: true,
      });
      await expect(call).toHaveAttribute("aria-expanded", "false");
      await call.click();
      const details = pane.getByRole("region", {
        name: scenario.path,
        exact: true,
      });
      if (scenario.nested) {
        await expect(details.getByRole("code").first()).toHaveText(js);
      } else {
        await expect(
          details.getByRole("grid", { name: "Tool arguments" }),
        ).toBeVisible();
        for (const [name, value] of Object.entries(scenario.args)) {
          await expect(
            details.getByRole("rowheader", { name, exact: true }),
          ).toBeVisible();
          await expect(details.getByText(value, { exact: true })).toBeVisible();
        }
      }
      await expect(
        details.getByText(scenario.result, { exact: true }),
      ).toBeVisible();
      await call.click();
      await expect(details).toBeHidden();
    },
  );
}

e2eTest(
  "keeps parallel tool activity visible when another tool finishes",
  async ({ app, llm, http }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Fetch both reports");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const firstCommand = `curl --silent --fail '${http.url("/first")}'`;
    const secondCommand = `curl --silent --fail '${http.url("/second")}'`;
    await llm.respond([
      m.tool.start("bash", {
        id: "first",
        arguments: { command: firstCommand, timeoutMs: 60_000 },
      }),
      m.tool.start("bash", {
        id: "second",
        arguments: { command: secondCommand, timeoutMs: 60_000 },
      }),
    ]);
    const [first, second] = await Promise.all([
      http.request("/first"),
      http.request("/second"),
    ]);
    const pane = app.page.getByRole("main");
    const activeTools = pane.getByLabel("Active tools");
    await expect(
      activeTools.getByText(`$ ${firstCommand}`, { exact: true }),
    ).toBeVisible();
    await expect(
      activeTools.getByText(`$ ${secondCommand}`, { exact: true }),
    ).toBeVisible();
    await pane.getByRole("button", { name: "Working", exact: true }).click();
    await expect(activeTools).toHaveCount(0);
    first.respond("First report");
    await pane
      .getByRole("button", { name: `${firstCommand} (bash)`, exact: true })
      .click();
    await expect(
      pane.getByRole("region", { name: "bash", exact: true }),
    ).toContainText("First report");
    const liveAggregate = pane.getByRole("button", {
      name: "Ran 1 command",
      exact: true,
    });
    await expect(liveAggregate).toBeVisible();
    await expect(
      liveAggregate.getByRole("status", { name: "Working" }),
    ).toBeVisible();
    await liveAggregate.hover();
    await expect(
      liveAggregate.getByRole("img", { name: "Expand tool activity" }),
    ).toBeVisible();
    await expect(pane.getByLabel("Active tools")).toHaveCount(0);
    await expect(
      pane.getByRole("button", {
        name: `${firstCommand} (bash)`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      pane.getByRole("button", {
        name: `${secondCommand} (bash)`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      pane.getByText(`$ ${secondCommand}`, { exact: true }),
    ).toHaveCount(1);
    second.respond("Second report");
    await llm.respond(m.assistant("Both reports are ready."));
    const settled = pane.getByRole("button", {
      name: "Ran 2 commands",
      exact: true,
    });
    await expect(settled).toBeVisible();
    await expect(
      settled.getByRole("img", { name: "Expand tool activity" }),
    ).toBeVisible();
    await expect(settled.getByRole("status", { name: "Working" })).toHaveCount(
      0,
    );
    await expect(pane.getByLabel("Active tools")).toHaveCount(0);
  },
);

e2eTest(
  "shows identical parallel commands as separate active work",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Run the same command twice");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const command = "sleep 5; echo done";
    await llm.respond([
      m.tool.start("bash", {
        id: "first",
        arguments: { command },
      }),
      m.tool.start("bash", {
        id: "second",
        arguments: { command },
      }),
    ]);

    await expect(
      app.page
        .getByLabel("Active tools")
        .getByText(`$ ${command}`, { exact: true }),
    ).toHaveCount(2);

    await llm.respond(m.assistant("Both commands finished."));
    await expect(
      app.page.getByText("Both commands finished.", { exact: true }),
    ).toBeVisible();
  },
);

e2eTest(
  "shows a generic label for unlabeled exec work",
  async ({ harness, app }) => {
    await harness.loadSession({
      title: "Generic tool work",
      messages: [
        m.user("Do the work"),
        m.exec({ js: "return 'done'", result: "Done" }),
      ],
    });

    const summary = app.page.getByRole("button", {
      name: "Used tools",
      exact: true,
    });
    await summary.click();
    await app.page
      .getByRole("button", { name: "Used tools (exec)", exact: true })
      .click();
    const details = app.page.getByRole("region", {
      name: "exec",
      exact: true,
    });
    await expect(details.getByRole("code").first()).toHaveText("return 'done'");
    await expect(details.getByText("Done", { exact: true })).toBeVisible();
  },
);

e2eTest(
  "deduplicates completed file activity by normalized path",
  async ({ harness, app }) => {
    await harness.loadSession({
      title: "Read project files",
      messages: [
        m.user("Read the project files"),
        m.read({ path: "./notes.md", result: "Notes" }),
        m.read({
          path: `${harness.paths.workspace}/notes.md`,
          result: "Notes again",
        }),
        m.read({ path: "README.md", result: "Readme" }),
      ],
    });

    await expect(
      app.page.getByRole("button", {
        name: "Read 2 files",
        exact: true,
      }),
    ).toBeVisible();
  },
);

e2eTest(
  "restores partial assistant text on reload and continues the same response",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
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

e2eTest(
  "shows running sessions and keeps completed results unread until opened",
  async ({ app, llm }) => {
    const listRequests: string[] = [];
    await app.page.route("**/rpc/sessions/list", async (route) => {
      listRequests.push(route.request().url());
      await route.abort();
    });
    // An interrupted transport must reconnect automatically before showing the list.
    let summaryConnections = 0;
    await app.page.route("**/rpc/server/watch", async (route) => {
      summaryConnections++;
      if (summaryConnections === 1) {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: "",
        });
        return;
      }
      await route.continue();
    });
    await app.page.reload();

    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Prepare my report");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const sidebar = app.page.getByRole("navigation", { name: "Workspace" });
    const row = sidebar.getByRole("row").filter({
      has: app.page.getByRole("link", {
        name: "Prepare my report",
        exact: true,
      }),
    });
    const sessionLink = row.getByRole("link", {
      name: "Prepare my report",
      exact: true,
    });
    const working = row.getByRole("status", { name: "Agent is working" });
    const unread = row.getByRole("img", { name: "Unread result" });
    await expect(sessionLink).toBeVisible();
    await expect(working).toBeVisible();
    await expect(unread).not.toBeVisible();

    // Opening a running session must not count its future result as read.
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await sessionLink.click();
    await expect(working).toBeVisible();
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const response = await llm.stream();
    response.write(m.assistant("The report is ready."));
    await expect(working).toBeVisible();
    response.end();
    await expect(unread).toBeVisible();
    await expect(working).not.toBeVisible();

    await app.page.reload();
    await expect(sessionLink).toBeVisible();
    await expect(unread).toBeVisible();
    const pendingWatches: Route[] = [];
    await app.page.route("**/rpc/sessions/watch", (route) => {
      pendingWatches.push(route);
    });
    let readAttempts = 0;
    await app.page.route("**/rpc/sessions/markRead", async (route) => {
      readAttempts++;
      if (readAttempts === 1) {
        await route.abort();
        return;
      }
      await route.continue();
    });
    await sessionLink.click();
    await expect.poll(() => pendingWatches.length).toBe(1);
    // Give a premature read receipt time to reach the sidebar before unblocking the transcript.
    await app.page.waitForTimeout(300);
    await expect(unread).toBeVisible();
    await pendingWatches[0]!.continue();
    await app.page.unroute("**/rpc/sessions/watch");
    await expect(app.page.getByRole("log")).toContainText(
      "The report is ready.",
    );
    await expect(unread).not.toBeVisible();
    expect(readAttempts).toBe(2);
    await app.page.unroute("**/rpc/sessions/markRead");
    await app.page.reload();
    await expect(sessionLink).toBeVisible();
    await expect(unread).not.toBeVisible();

    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Add a conclusion");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(working).toBeVisible();
    await llm.respond(m.assistant("Here is the conclusion."));
    await expect(working).not.toBeVisible();
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page.reload();
    await expect(sessionLink).toBeVisible();
    await expect(unread).not.toBeVisible();
    expect(summaryConnections).toBeGreaterThanOrEqual(2);
    expect(listRequests).toEqual([]);
  },
);

e2eTest(
  "shares unread results and read receipts between windows",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Work while I am away");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      app.page.getByRole("status", { name: "Agent is working" }),
    ).toBeVisible();
    const otherWindow = await app.openWindow();
    await otherWindow.getByRole("main").waitFor();
    await otherWindow
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await llm.respond(m.assistant("Your result arrived while you were away."));
    const unread = app.page.getByRole("img", { name: "Unread result" });
    await expect(unread).toBeVisible();
    await expect(
      otherWindow.getByRole("img", { name: "Unread result" }),
    ).toBeVisible();
    await app.page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: "Work while I am away", exact: true })
      .click();
    await expect(unread).not.toBeVisible();
    await expect(
      otherWindow.getByRole("img", { name: "Unread result" }),
    ).not.toBeVisible();
    await otherWindow.close();
  },
);

e2eTest(
  "archives an open thread from its hover action",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const pane = app.page.getByRole("main");
    await pane
      .getByLabel("Message", { exact: true })
      .fill("Archive this thread");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(m.assistant("This thread is ready to archive."));

    const sidebar = app.page.getByRole("navigation", { name: "Workspace" });
    const sessionLink = sidebar.getByRole("link", {
      name: "Archive this thread",
      exact: true,
    });
    const row = sidebar.getByRole("row").filter({
      has: app.page.getByRole("link", {
        name: "Archive this thread",
        exact: true,
      }),
    });
    await expect(sessionLink).toBeVisible();
    const markDone = row.getByRole("button", {
      name: "Mark done",
      exact: true,
    });
    await row.hover();
    await expect(markDone).toBeVisible();
    await app.page.mouse.move(900, 500);
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(markDone).toBeVisible();
    await markDone.click();
    await app.page.setViewportSize({ width: 1200, height: 800 });

    await expect(sessionLink).not.toBeVisible();
    await expect(app.page.getByText("Done", { exact: true })).not.toBeVisible();
    await expect(pane.getByRole("log")).toContainText(
      "This thread is ready to archive.",
    );

    await app.page.reload();
    await expect(sessionLink).not.toBeVisible();
    await expect(app.page.getByText("Done", { exact: true })).not.toBeVisible();
    await expect(pane.getByRole("log")).toContainText(
      "This thread is ready to archive.",
    );

    await app.page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('["halo:workspace-panes",'))
          localStorage.removeItem(key);
      }
      history.replaceState(undefined, "", location.pathname + location.search);
    });
    await app.page.reload();
    await expect(
      app.page.getByRole("main", { name: "New session" }),
    ).toBeVisible();
    await expect(sessionLink).not.toBeVisible();
  },
);

e2eTest(
  "Tiptap submits edited source fragments from the composer",
  async ({ app, llm }) => {
    const editor = app.page
      .getByRole("main", { name: "New session" })
      .getByLabel("Message", { exact: true });
    await editor.fill("");
    await editor.evaluate((element) => {
      const data = new DataTransfer();
      data.setData(
        "text/html",
        "<p>Send <strong>this</strong> and <em>that</em>.</p>",
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await editor.locator("strong").click();
    const source = editor.getByRole("textbox", { name: "Markdown syntax" });
    await expect(source).toHaveText("**this**");
    await source.fill("*changed*");
    await source.press("ControlOrMeta+Enter");
    await llm.respond(({ messages }) => {
      expect(messageText(messages.at(-1)!)).toContain(
        "Send *changed* and *that*.",
      );
      return m.assistant("Received the edited formatting.");
    });
    await expect(
      app.page.getByRole("log", { name: "Session transcript" }),
    ).toContainText("Received the edited formatting.");
  },
);
