import { expect, type Page } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";

const sectionHeaders = /^(Collapse|Expand) (Favorites|Artifacts|Threads)$/;

e2eTest(
  "lists every artifact kind under Artifacts and filters by kind",
  async ({ app, harness }) => {
    await harness.tools.files.write({
      path: "Product brief.md",
      content: "# Product brief",
    });
    await harness.tools.bash.run({
      command: "mkdir -p .halo/extensions/appointments",
    });
    await app.server.rpc.automations.save({
      extensionId: "appointments",
      name: "Book haircut",
      activation: {
        type: "routine",
        schedule: { cron: "0 8 * * 1", timezone: "UTC" },
      },
      action: { type: "runScript", command: "echo booked" },
    });
    await app.server.rpc.automations.save({
      name: "Daily check",
      activation: {
        type: "routine",
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
      },
      action: { type: "runScript", command: "echo checked" },
    });
    const sidebar = workspaceSidebar(app.page);
    const artifacts = sidebar.getByRole("rowgroup", {
      name: "Artifacts",
      exact: true,
    });
    const extension = artifacts.getByRole("row", { name: /^appointments/ });

    await expect(extension).toContainText("Not running");
    await expect(artifacts.getByRole("link")).toHaveText([
      "appointments",
      "Daily check",
      "Product brief.md",
    ]);

    await chooseFilter(app.page, "Extensions");
    await expect(artifacts.getByRole("link")).toHaveText(["appointments"]);

    // Extension rows are hidden, so their automations are listed directly.
    await chooseFilter(app.page, "Automations");
    await expect(extension).toHaveCount(0);
    await expect(artifacts.getByRole("link")).toHaveText([
      "Book haircut",
      "Daily check",
    ]);

    await chooseFilter(app.page, "Docs");
    await expect(artifacts.getByRole("link")).toHaveText(["Product brief.md"]);
    await app.page.reload();
    await expect(artifacts.getByRole("link")).toHaveText(["Product brief.md"]);

    // Creating a file while files are filtered out shows every kind again.
    await chooseFilter(app.page, "Extensions");
    await sidebar
      .getByRole("button", { name: "Collapse Artifacts", exact: true })
      .click();
    await createArtifact(app.page, "File");
    await expect(
      sidebar.getByRole("textbox", { name: "New file name", exact: true }),
    ).toBeVisible();
    await expect(artifacts.getByRole("link")).toHaveText([
      "appointments",
      "Daily check",
      "Product brief.md",
    ]);
  },
);

e2eTest(
  "favorites hide their star at rest and expand favorited extensions",
  async ({ app, harness }) => {
    await harness.tools.files.write({ path: "Notes.md", content: "# Notes" });
    await harness.tools.bash.run({
      command: "mkdir -p .halo/extensions/appointments",
    });
    await app.server.rpc.automations.save({
      extensionId: "appointments",
      name: "Book haircut",
      activation: {
        type: "routine",
        schedule: { cron: "0 8 * * 1", timezone: "UTC" },
      },
      action: { type: "runScript", command: "echo booked" },
    });
    const sidebar = workspaceSidebar(app.page);
    const favorites = sidebar.getByRole("rowgroup", {
      name: "Favorites",
      exact: true,
    });
    const artifacts = sidebar.getByRole("rowgroup", {
      name: "Artifacts",
      exact: true,
    });

    const notes = artifacts.getByRole("row", { name: "Notes.md", exact: true });
    await notes.hover();
    await notes
      .getByRole("button", { name: "Add Notes.md to favorites", exact: true })
      .click();
    await expect(
      favorites.getByRole("link", { name: "Notes.md", exact: true }),
    ).toBeVisible();
    const toggle = notes.getByRole("button", {
      name: "Remove Notes.md from favorites",
      exact: true,
    });
    await toggle.blur();
    await app.page.mouse.move(900, 500);
    await expect(toggle).toHaveCSS("opacity", "0");

    const extension = artifacts.getByRole("row", { name: /^appointments/ });
    await extension.hover();
    await extension
      .getByRole("button", {
        name: "Add appointments to favorites",
        exact: true,
      })
      .click();

    // A favorite that is not running must never flash as unavailable.
    await app.page.addInitScript(() => {
      new MutationObserver(() => {
        const favoritesGroup = document.querySelector(
          'nav[aria-label="Workspace"] [role="rowgroup"][aria-label="Favorites"]',
        );
        if (favoritesGroup?.textContent?.includes("Unavailable"))
          document.documentElement.dataset.sawUnavailable = "true";
      }).observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    await app.page.reload();
    const favorite = favorites.getByRole("row", { name: /^appointments/ });
    await expect(favorite).toContainText("Not running");
    await favorite
      .getByRole("button", { name: "Expand appointments", exact: true })
      .click();
    await expect(
      favorites.getByRole("link", { name: "Book haircut", exact: true }),
    ).toBeVisible();
    await expect(
      artifacts.getByRole("link", { name: "Book haircut", exact: true }),
    ).toHaveCount(0);
    await expect(
      favorites.getByRole("link", { name: "Notes.md", exact: true }),
    ).toBeVisible();
    await expect(app.page.locator("html")).not.toHaveAttribute(
      "data-saw-unavailable",
      "true",
    );
  },
);

// Renderer coverage is lost on reload, so these handlers run in one page session.
e2eTest(
  "runs section actions and collapses sections in a fixed order",
  async ({ app }) => {
    const sidebar = workspaceSidebar(app.page);
    const toolbar = sidebar.getByRole("toolbar", { name: "Workspace actions" });
    await toolbar.getByRole("button", { name: "Desktop", exact: true }).click();
    await expect(
      app.page.getByRole("region", { name: "Desktop", exact: true }),
    ).toBeVisible();
    await sidebar
      .getByRole("button", { name: "Collapse Threads", exact: true })
      .click();
    await sidebar
      .getByRole("button", { name: "Expand Threads", exact: true })
      .hover();
    await sidebar
      .getByRole("rowgroup", { name: "Threads", exact: true })
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await expect(
      app.page.getByRole("main", { name: "New thread", exact: true }),
    ).toBeVisible();
    await createArtifact(app.page, "Folder");
    const folderName = sidebar.getByRole("textbox", {
      name: "New folder name",
      exact: true,
    });
    await folderName.fill("Plans");
    // Repeated focus changes must commit once, even before pending renders.
    await folderName.evaluate((input: HTMLInputElement) => {
      input.blur();
      input.focus();
      input.blur();
    });
    await expect(
      sidebar.getByRole("link", { name: "Plans", exact: true }),
    ).toBeVisible();

    await sidebar
      .getByRole("button", { name: "Expand Threads", exact: true })
      .click();
    await sidebar
      .getByRole("button", { name: "Collapse Threads", exact: true })
      .click();
    await expect(
      sidebar.getByRole("button", { name: "Expand Threads", exact: true }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: sectionHeaders }),
    ).toHaveText(["Favorites", "Artifacts", "Threads"]);
    await expect(
      sidebar.getByRole("button", { name: /^Reorder / }),
    ).toHaveCount(0);
  },
);

function workspaceSidebar(page: Page) {
  return page.getByRole("navigation", { name: "Workspace", exact: true });
}

e2eTest(
  "creates an agent with a name, introduces itself quietly, and saves settings on the same conversation",
  async ({ app, llm }) => {
    const sidebar = workspaceSidebar(app.page);
    const agents = sidebar.getByRole("region", { name: "Agents", exact: true });
    await expect(agents).toContainText("Create an agent");
    await agents
      .getByRole("button", { name: "New agent", exact: true })
      .click();
    const create = app.page.getByRole("dialog", {
      name: "New agent",
      exact: true,
    });
    await expect(
      create.getByRole("button", { name: "Create", exact: true }),
    ).toBeDisabled();
    await create
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Canceled");
    await create.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await app.server.rpc.agents.list()).toEqual([]);
    await agents
      .getByRole("button", { name: "New agent", exact: true })
      .click();
    const name = create.getByRole("textbox", { name: "Name", exact: true });
    await expect(name).toHaveValue("");
    await name.fill("  Reading guide  ");
    await name.press("Enter");
    const pane = app.page.getByRole("main", {
      name: "Reading guide",
      exact: true,
    });
    await expect(pane).toBeVisible();
    await expect(
      pane.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    // Opening and typing do not wait for the model's first reply.
    await pane.getByLabel("Message", { exact: true }).fill("A book about Rome");
    await expect(
      pane.getByRole("article", { name: "You message", exact: true }),
    ).toHaveCount(0);
    await llm.respond(
      m.tool.start("send_user_message", {
        id: "intro",
        arguments: {
          text: "I'm your reading guide. What would you like to explore?",
        },
      }),
    );
    await expect(pane).toContainText("What would you like to explore?");
    await llm.respond(m.assistant("Private execution note"));
    await expect(pane).not.toContainText("Private execution note");
    await expect(pane).not.toContainText("send_user_message");
    await agents
      .getByRole("button", { name: "New agent", exact: true })
      .focus();
    await app.page.keyboard.press("Tab");
    await expect(
      agents.getByRole("button", { name: "Reading guide", exact: true }),
    ).toBeFocused();
    await expect(app.page.getByRole("tooltip")).toContainText(
      "Draft: A book about Rome",
    );
    await expect(app.page.getByRole("tooltip")).not.toContainText(
      "Private execution note",
    );
    await expect(
      sidebar
        .getByRole("rowgroup", { name: "Threads", exact: true })
        .getByRole("link"),
    ).toHaveCount(0);
    const [agent] = await app.server.rpc.agents.list();
    expect(agent?.name).toBe("Reading guide");
    expect(agent?.instructions).toBe("");

    const settingsButton = app.page.getByRole("button", {
      name: "Agent settings",
      exact: true,
    });
    await expect(
      app.page.getByRole("button", { name: "Done", exact: true }),
    ).toHaveCount(0);
    await settingsButton.click();
    const settings = app.page.getByRole("dialog", {
      name: "Agent settings",
      exact: true,
    });
    await settings
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Not saved");
    await settings
      .getByRole("textbox", { name: "Instructions", exact: true })
      .fill("Ignore this draft");
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await app.server.rpc.agents.list())[0]).toEqual(agent);
    await settingsButton.click();
    await expect(
      settings.getByRole("textbox", { name: "Name", exact: true }),
    ).toHaveValue("Reading guide");
    await expect(
      settings.getByRole("textbox", { name: "Instructions", exact: true }),
    ).toHaveValue("");
    await settings
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Research");
    await settings
      .getByRole("textbox", { name: "Instructions", exact: true })
      .fill("Prefer long histories of Rome.");
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    const renamed = app.page.getByRole("main", {
      name: "Research",
      exact: true,
    });
    await expect(renamed).toBeVisible();
    await expect(
      agents.getByRole("button", { name: "Research", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      app.page
        .getByTestId("pane-header")
        .getByRole("heading", { name: "Research", exact: true }),
    ).toBeVisible();
    await expect(renamed.getByLabel("Message", { exact: true })).toHaveText(
      "A book about Rome",
    );
    expect((await app.server.rpc.agents.list())[0]).toEqual({
      ...agent,
      name: "Research",
      instructions: "Prefer long histories of Rome.",
    });
    await renamed.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) => {
      expect(messages.map(messageText).join("\n")).toContain(
        "Prefer long histories of Rome.",
      );
      return m.tool.start("send_user_message", {
        id: "recommend",
        arguments: { text: "Try SPQR." },
      });
    });
    await llm.respond(m.assistant("Done privately"));
    await expect(renamed).toContainText("Try SPQR.");
    await app.page.reload();
    await expect(renamed).toContainText("Try SPQR.");
    await expect(settingsButton).toBeVisible();
    await agents
      .getByRole("button", { name: "New agent", exact: true })
      .focus();
    await app.page.keyboard.press("Tab");
    await expect(
      agents.getByRole("button", { name: "Research", exact: true }),
    ).toBeFocused();
    await expect(app.page.getByRole("tooltip")).toContainText("Research");
    await expect(app.page.getByRole("tooltip")).toContainText("Try SPQR.");
    await expect(app.page.getByRole("tooltip")).not.toContainText(
      "Done privately",
    );
    await expect(
      app.page.getByRole("button", { name: "Done", exact: true }),
    ).toHaveCount(0);
  },
);

e2eTest(
  "keeps several agents pinned in creation order and acknowledges delivered messages on return",
  async ({ app, llm }) => {
    const first = await app.server.rpc.agents.new({
      requestId: "first",
      name: "Guide",
      instructions: "",
    });
    const sidebar = workspaceSidebar(app.page);
    const agents = sidebar.getByRole("region", { name: "Agents", exact: true });
    const circle = agents.getByRole("button", { name: "Guide", exact: true });
    await expect(
      circle.getByLabel("Agent is working", { exact: true }),
    ).toBeVisible();
    await llm.respond(
      m.tool.start("send_user_message", {
        id: "first-intro",
        arguments: { text: "Hello from Guide" },
      }),
    );
    await llm.respond(m.assistant("Private"));
    await expect(
      circle.getByRole("img", { name: "Unread result", exact: true }),
    ).toBeVisible();
    await app.server.rpc.agents.new({
      requestId: "second",
      name: "Guide",
      instructions: "",
    });
    await llm.respond(m.assistant("No delivery"));
    await app.server.rpc.agents.new({
      requestId: "third",
      name: "A very long agent name for a research assistant",
      instructions: "",
    });
    await llm.respond(m.assistant("No delivery"));
    const circleNames = [
      "New agent",
      "Guide",
      "Guide",
      "A very long agent name for a research assistant",
    ];
    await expect(agents.getByRole("button")).toHaveCount(circleNames.length);
    for (const [index, circleName] of circleNames.entries()) {
      await expect(agents.getByRole("button").nth(index)).toHaveAccessibleName(
        circleName,
      );
    }
    const firstCircle = agents
      .getByRole("button", { name: "Guide", exact: true })
      .first();
    await firstCircle.click();
    await expect(
      app.page.getByRole("main", { name: "Guide", exact: true }),
    ).toContainText("Hello from Guide");
    await expect(
      firstCircle.getByRole("img", { name: "Unread result", exact: true }),
    ).toHaveCount(0);
    await expect(firstCircle).toHaveAttribute("aria-pressed", "true");
    expect((await app.server.rpc.agents.list())[0]?.threadId).toBe(
      first.threadId,
    );
    await sidebar.getByRole("button", { name: "Desktop", exact: true }).click();
    await firstCircle.click();
    await expect(
      app.page.getByRole("main", { name: "Guide", exact: true }),
    ).toContainText("Hello from Guide");
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.page
      .getByRole("button", { name: "Open sidebar", exact: true })
      .click();
    await expect(firstCircle).toBeVisible();
    await firstCircle.click();
    await expect(sidebar).toBeHidden();
    await expect(
      app.page.getByRole("button", { name: "Agent settings", exact: true }),
    ).toBeVisible();
  },
);

async function chooseFilter(page: Page, label: string) {
  await workspaceSidebar(page)
    .getByRole("button", { name: /^(Collapse|Expand) Artifacts$/ })
    .hover();
  await workspaceSidebar(page)
    .getByRole("button", { name: "Filter artifacts", exact: true })
    .click();
  // Maui appends a checkmark to the selected option's accessible name.
  await page
    .getByRole("menuitemradio", { name: new RegExp(`^${label}`) })
    .click();
}

async function createArtifact(page: Page, kind: "File" | "Folder") {
  await workspaceSidebar(page)
    .getByRole("button", { name: /^(Collapse|Expand) Artifacts$/ })
    .hover();
  await workspaceSidebar(page)
    .getByRole("button", { name: "Create artifact", exact: true })
    .click();
  await page.getByRole("menuitem", { name: kind, exact: true }).click();
}

e2eTest(
  "imports browser favorites and receives favorites changed on another device",
  async ({ app, harness }, testInfo) => {
    await harness.tools.files.write({ path: "Local.md", content: "# Local" });
    await harness.tools.files.write({ path: "Remote.md", content: "# Remote" });
    const { workspaceRoot } = await app.server.rpc.workspace.get();
    await app.server.rpc.favorites.add({ favoriteIds: ["file:Remote.md"] });
    await app.page.evaluate(
      ({ root }) => {
        localStorage.setItem(
          `halo:sidebar:${JSON.stringify(["e2e-user", root])}`,
          JSON.stringify({
            favoriteIds: ["file:Local.md"],
            collapsedSections: [],
            artifactFilter: "all",
          }),
        );
      },
      { root: workspaceRoot },
    );
    await app.page.reload();
    const favorites = workspaceSidebar(app.page).getByRole("rowgroup", {
      name: "Favorites",
      exact: true,
    });
    await expect(
      favorites.getByRole("link", { name: "Local.md", exact: true }),
    ).toBeVisible();
    await expect(
      favorites.getByRole("link", { name: "Remote.md", exact: true }),
    ).toBeVisible();
    await app.server.rpc.favorites.toggle({ favoriteId: "file:Remote.md" });
    await expect(
      favorites.getByRole("link", { name: "Remote.md", exact: true }),
    ).toHaveCount(0);
    await app.page.screenshot({
      path: testInfo.outputPath("favorites-desktop.png"),
    });
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.page
      .getByRole("button", { name: "Open sidebar", exact: true })
      .click();
    await expect(
      favorites.getByRole("link", { name: "Local.md", exact: true }),
    ).toBeVisible();
    // Maui's drawer uses a JS spring; let it settle before the visual capture.
    await app.page.waitForTimeout(500);
    await app.page.screenshot({
      path: testInfo.outputPath("favorites-mobile.png"),
      animations: "disabled",
    });
  },
);
