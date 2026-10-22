import { expect } from "@playwright/test";
import { m } from "@get-halo/shared/testing";
import { e2eTest } from "./e2eTest.js";

e2eTest(
  "searches saved files and threads and opens a result",
  async ({ app, llm }) => {
    await app.server.rpc.workspace.writeFile({
      path: "notes.txt",
      content:
        "A careful field report describes the wet creek and the trail along the ridge before a silver marmot waits here beside the cairn while hikers record the time and weather.",
    });
    const thread = await app.server.rpc.thread.new();
    const { submissionId } = await app.server.rpc.thread.prompt({
      ...thread,
      text: "Find the silver marmot",
    });
    const completion = app.server.rpc.thread.wait({
      sessionId: thread.sessionId,
      submissionId,
    });
    await llm.respond(m.assistant("The silver marmot is in the notes."));
    expect(await completion).toEqual({ status: "completed" });

    await app.page
      .getByRole("link", { name: "Find the silver marmot" })
      .click();
    await app.page.keyboard.press("ControlOrMeta+Shift+f");
    const dialog = app.page.getByRole("dialog", { name: "Search workspace" });
    await expect(
      dialog.getByRole("textbox", { name: "Search workspace" }),
    ).toHaveAttribute("placeholder", "Search files and threads");
    await dialog
      .getByRole("textbox", { name: "Search workspace" })
      .fill("silver marmot");
    const results = dialog.getByRole("list", { name: "Search results" });
    await expect(results).toContainText("notes.txt");
    await expect(results).toContainText("Find the silver marmot");
    await expect(results).toContainText("Thread · Find the silver marmot");
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
