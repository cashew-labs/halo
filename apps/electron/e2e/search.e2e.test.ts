import { expect } from "@playwright/test";
import { m } from "@get-halo/shared/testing";
import { e2eTest } from "./e2eTest.js";

e2eTest(
  "finds current file buffers and visible conversation text",
  async ({ app, llm }) => {
    await app.server.rpc.workspace.writeFile({
      path: "plain.txt",
      content: "Silver marmot and silver marmot",
    });
    await app.server.rpc.workspace.writeFile({
      path: "notes.md",
      content: "# Silver marmot\n\nBefore  \nAnother silver marmot",
    });
    await app.server.rpc.workspace.writeFile({
      path: "source.ts",
      content: "const marmot = 'silver marmot';",
    });

    await app.page.getByRole("link", { name: "plain.txt" }).click();
    await app.pressShortcut({ key: "f" });
    const find = app.page.getByRole("search", { name: "Find in tab" });
    await find
      .getByRole("textbox", { name: "Find in tab" })
      .fill("SILVER MARMOT");
    await expect(find).toContainText("1 of 2");
    await expect(
      find.getByRole("textbox", { name: "Find in tab" }),
    ).toBeFocused();
    const plainHighlight = app.page
      .getByRole("main", { name: "plain.txt" })
      .locator("mark");
    await expect(plainHighlight).toHaveText("Silver marmot");
    await expect(plainHighlight).toBeVisible();
    await find.getByRole("button", { name: "Next match" }).click();
    await expect(find).toContainText("2 of 2");
    const plainEditor = app.page.getByRole("textbox", { name: "plain.txt" });
    await plainEditor.focus();
    await plainEditor.evaluate((element: HTMLTextAreaElement) =>
      element.setSelectionRange(14, 17),
    );
    await plainEditor.press("Backspace");
    await plainEditor.pressSequentially("and");
    await expect(plainEditor).toHaveValue("Silver marmot and silver marmot");
    await expect
      .poll(
        async () =>
          await plainEditor.evaluate(
            (element: HTMLTextAreaElement) => element.selectionStart,
          ),
      )
      .toBe(17);
    await find.getByRole("textbox", { name: "Find in tab" }).focus();
    await app.page.keyboard.press("Escape");
    await expect(find).toBeHidden();
    await expect(plainHighlight).toHaveCount(0);
    await plainEditor.focus();
    await plainEditor.pressSequentially("XY");
    await expect(plainEditor).toHaveValue("Silver marmot andXY silver marmot");

    await app.page.getByRole("link", { name: "notes.md" }).click();
    await app.page.keyboard.press("ControlOrMeta+f");
    await find
      .getByRole("textbox", { name: "Find in tab" })
      .fill("silver marmot");
    await expect(find).toContainText("1 of 2");
    await expect(
      find.getByRole("textbox", { name: "Find in tab" }),
    ).toBeFocused();
    await find.getByRole("button", { name: "Next match" }).click();
    await expect(find).toContainText("2 of 2");
    const markdownHighlight = app.page
      .getByRole("main", { name: "notes.md" })
      .locator(".halo-find-active-match");
    await expect(markdownHighlight).toHaveText("silver marmot");
    await expect(markdownHighlight).toBeVisible();
    const markdownEditor = app.page.locator(
      '.ProseMirror[aria-label="notes.md"]',
    );
    await find.getByRole("textbox", { name: "Find in tab" }).focus();
    await app.page.keyboard.press("Escape");
    await expect(markdownHighlight).toHaveCount(0);
    await markdownEditor.focus();
    await expect
      .poll(
        async () =>
          await app.page.evaluate(() => window.getSelection()?.toString()),
      )
      .toBe("silver marmot");

    await app.page.keyboard.press("ControlOrMeta+f");
    await expect(find).toContainText("2 of 2");
    const paragraph = markdownEditor.locator("p").first();
    await markdownEditor.focus();
    await paragraph.evaluate((element) => {
      const text = element.firstChild;
      if (text === null) return;
      const range = document.createRange();
      range.setStart(text, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await app.page.keyboard.press("X");
    await expect(paragraph).toContainText("XBefore");
    await app.page.keyboard.press("Y");
    await expect(paragraph).toContainText("XYBefore");
    await expect(markdownHighlight).toHaveText("silver marmot");

    await app.page.getByRole("link", { name: "source.ts" }).click();
    await app.page.keyboard.press("ControlOrMeta+f");
    await find.getByRole("textbox", { name: "Find in tab" }).fill("marmot");
    await expect(find).toContainText("1 of 2");
    await expect(
      find.getByRole("textbox", { name: "Find in tab" }),
    ).toBeFocused();
    await app.page.keyboard.press("Escape");

    const session = await app.server.rpc.thread.new();
    const { submissionId } = await app.server.rpc.thread.prompt({
      ...session,
      text: "The silver marmot is here",
    });
    const completion = app.server.rpc.thread.wait({
      sessionId: session.sessionId,
      submissionId,
    });
    await llm.respond(m.assistant("I see the silver marmot."));
    expect(await completion).toEqual({ status: "completed" });
    await app.page
      .getByRole("link", { name: "The silver marmot is here" })
      .click();
    await app.page.keyboard.press("ControlOrMeta+f");
    const sessionFindInput = find.getByRole("textbox", {
      name: "Find in tab",
    });
    await sessionFindInput.fill("silver");
    await expect(sessionFindInput).toBeFocused();
    await sessionFindInput.pressSequentially(" marmot");
    await expect(find).toContainText("1 of 2");
    await expect(sessionFindInput).toBeFocused();
    await sessionFindInput.pressSequentially("s");
    await expect(sessionFindInput).toHaveValue("silver marmots");
    await expect(sessionFindInput).toBeFocused();
  },
);

e2eTest(
  "reveals offscreen matches when navigating Find",
  async ({ app, llm }) => {
    const filler = Array.from({ length: 100 }, (_, index) => `Filler ${index}`);
    await app.server.rpc.workspace.writeFile({
      path: "long.txt",
      content: ["amber beacon", ...filler, "amber beacon"].join("\n"),
    });
    await app.server.rpc.workspace.writeFile({
      path: "long.md",
      content: ["# amber beacon", ...filler, "amber beacon"].join("\n\n"),
    });
    await app.server.rpc.workspace.writeFile({
      path: "long.ts",
      content: [
        "const amberBeacon = 1;",
        ...filler.map((_, index) => `const filler${index} = ${index};`),
        "const amberBeaconTwo = 2;",
      ].join("\n"),
    });

    await app.page.getByRole("link", { name: "long.txt" }).click();
    await app.page.keyboard.press("ControlOrMeta+f");
    const find = app.page.getByRole("search", { name: "Find in tab" });
    await find
      .getByRole("textbox", { name: "Find in tab" })
      .fill("amber beacon");
    await expect(find).toContainText("1 of 2");
    const textMatch = app.page
      .getByRole("main", { name: "long.txt" })
      .locator("mark");
    await expect(textMatch).toBeInViewport();
    await find.getByRole("textbox", { name: "Find in tab" }).press("Enter");
    await expect(find).toContainText("2 of 2");
    await expect(textMatch).toBeInViewport();
    await find.getByRole("textbox", { name: "Find in tab" }).press("ArrowUp");
    await expect(find).toContainText("1 of 2");
    await expect(textMatch).toBeInViewport();
    await find.getByRole("textbox", { name: "Find in tab" }).press("ArrowDown");
    await expect(find).toContainText("2 of 2");
    await expect(textMatch).toBeInViewport();
    await find.getByRole("textbox", { name: "Find in tab" }).fill("Filler 99");
    await expect(find).toContainText("1 of 1");
    await expect(textMatch).toBeInViewport();
    await app.page
      .getByRole("textbox", { name: "long.txt" })
      .evaluate((editor: HTMLTextAreaElement) => editor.scrollTo(0, 0));
    await expect(textMatch).not.toBeInViewport();
    await find.getByRole("textbox", { name: "Find in tab" }).press("Enter");
    await expect(textMatch).toBeInViewport();

    await app.page.getByRole("link", { name: "long.md" }).click();
    await app.page.keyboard.press("ControlOrMeta+f");
    await find.getByRole("textbox", { name: "Find in tab" }).fill("");
    await find
      .getByRole("textbox", { name: "Find in tab" })
      .fill("amber beacon");
    await expect(find).toContainText("1 of 2");
    const markdownMatch = app.page
      .getByRole("main", { name: "long.md" })
      .locator(".halo-find-active-match");
    await expect(markdownMatch).toBeInViewport();
    await find.getByRole("button", { name: "Next match" }).click();
    await expect(find).toContainText("2 of 2");
    await expect(markdownMatch).toBeInViewport();

    await app.page.getByRole("link", { name: "long.ts" }).click();
    await app.page.keyboard.press("ControlOrMeta+f");
    await find.getByRole("textbox", { name: "Find in tab" }).fill("");
    await find
      .getByRole("textbox", { name: "Find in tab" })
      .fill("amberBeacon");
    await expect(find).toContainText("1 of 2");
    await find.getByRole("button", { name: "Next match" }).click();
    await expect(find).toContainText("2 of 2");
    await expect(
      app.page
        .getByRole("main", { name: "long.ts" })
        .getByText("const amberBeaconTwo = 2;", { exact: true }),
    ).toBeInViewport();

    const session = await app.server.rpc.thread.new();
    const { submissionId } = await app.server.rpc.thread.prompt({
      ...session,
      text: "Review the long field note",
    });
    const completion = app.server.rpc.thread.wait({
      sessionId: session.sessionId,
      submissionId,
    });
    await llm.respond(
      m.assistant(["amber beacon", ...filler, "amber beacon"].join("\n\n")),
    );
    expect(await completion).toEqual({ status: "completed" });
    await app.page
      .getByRole("link", { name: "Review the long field note" })
      .click();
    await app.page.keyboard.press("ControlOrMeta+f");
    await find.getByRole("textbox", { name: "Find in tab" }).fill("");
    await find
      .getByRole("textbox", { name: "Find in tab" })
      .fill("amber beacon");
    await expect(find).toContainText("1 of 2");
    const sessionMatches = app.page
      .getByRole("log", { name: "Session transcript" })
      .getByText("amber beacon", { exact: true });
    await expect(sessionMatches).toHaveCount(2);
    await expect(sessionMatches.first()).toBeInViewport();
    await find.getByRole("button", { name: "Next match" }).click();
    await expect(find).toContainText("2 of 2");
    await expect(sessionMatches.last()).toBeInViewport();
    await find.getByRole("button", { name: "Previous match" }).click();
    await expect(find).toContainText("1 of 2");
    await expect(sessionMatches.first()).toBeInViewport();
  },
);

e2eTest("opens the matching visible Markdown result", async ({ app }) => {
  await app.server.rpc.workspace.writeFile({
    path: "notes.md",
    content: "# foo\n\n[other](foo)\n\nfoo\n",
  });

  await app.page.getByRole("link", { name: "notes.md" }).click();
  await app.page.keyboard.press("ControlOrMeta+Shift+f");
  const dialog = app.page.getByRole("dialog", { name: "Search workspace" });
  await dialog.getByRole("textbox", { name: "Search workspace" }).fill("foo");
  const hits = dialog
    .getByRole("list", { name: "Search results" })
    .getByRole("button")
    .filter({ hasText: "notes.md" });
  await expect(hits).toHaveCount(2);
  await hits.nth(1).click();

  const find = app.page.getByRole("search", { name: "Find in tab" });
  await expect(find).toContainText("2 of 2");
  const document = app.page.getByRole("main", { name: "notes.md" });
  await expect(document.locator("p .halo-find-active-match")).toHaveText("foo");
  await expect(document.locator("h1 .halo-find-active-match")).toHaveCount(0);
});

e2eTest(
  "searches saved files and sessions and opens a result",
  async ({ app, llm }) => {
    await app.server.rpc.workspace.writeFile({
      path: "notes.txt",
      content:
        "A careful field report describes the wet creek and the trail along the ridge before a silver marmot waits here beside the cairn while hikers record the time and weather.",
    });
    const session = await app.server.rpc.thread.new();
    const { submissionId } = await app.server.rpc.thread.prompt({
      ...session,
      text: "Find the silver marmot",
    });
    const completion = app.server.rpc.thread.wait({
      sessionId: session.sessionId,
      submissionId,
    });
    await llm.respond(m.assistant("The silver marmot is in the notes."));
    expect(await completion).toEqual({ status: "completed" });

    await app.page
      .getByRole("link", { name: "Find the silver marmot" })
      .click();
    await app.page.keyboard.press("ControlOrMeta+Shift+f");
    const dialog = app.page.getByRole("dialog", { name: "Search workspace" });
    await dialog
      .getByRole("textbox", { name: "Search workspace" })
      .fill("silver marmot");
    const results = dialog.getByRole("list", { name: "Search results" });
    await expect(results).toContainText("notes.txt");
    await expect(results).toContainText("Find the silver marmot");
    const fileHit = results
      .getByRole("button")
      .filter({ hasText: "notes.txt" });
    await expect(fileHit).toContainText("trail along the ridge before a");
    await expect(fileHit).toContainText("hikers record the time and weather");
    await expect(fileHit.locator("mark")).toHaveText("silver marmot");
    await fileHit.click();
    await expect(
      app.page.getByRole("main", { name: "notes.txt" }),
    ).toBeVisible();
    await expect(
      app.page.getByRole("search", { name: "Find in tab" }),
    ).toContainText("1 of 1");

    await app.page.keyboard.press("ControlOrMeta+Shift+f");
    await results
      .getByRole("button")
      .filter({ hasText: "The silver marmot is in the notes." })
      .click();
    await expect(
      app.page.getByRole("main", { name: "Find the silver marmot" }),
    ).toBeVisible();
    await expect(
      app.page.getByRole("search", { name: "Find in tab" }),
    ).toContainText("2 of 2");

    await app.page.keyboard.press("ControlOrMeta+Shift+f");
    await dialog
      .getByRole("textbox", { name: "Search workspace" })
      .fill("no matching phrase");
    await expect(dialog).toContainText("No results for “no matching phrase”.");
  },
);
