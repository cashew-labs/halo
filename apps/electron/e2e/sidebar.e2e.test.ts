import { expect, type Locator, type Page } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";

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
      .getByRole("toolbar", { name: "Workspace actions" })
      .getByRole("button", { name: "New Markdown file", exact: true })
      .click();
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
  "runs toolbar actions and collapses and reorders sections",
  async ({ app }) => {
    const sidebar = workspaceSidebar(app.page);
    const toolbar = sidebar.getByRole("toolbar", { name: "Workspace actions" });
    await toolbar.getByRole("button", { name: "Desktop", exact: true }).click();
    await expect(
      app.page.getByRole("region", { name: "Desktop", exact: true }),
    ).toBeVisible();
    await toolbar
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await expect(
      app.page.getByRole("main", { name: "New thread", exact: true }),
    ).toBeVisible();
    await toolbar
      .getByRole("button", { name: "New folder", exact: true })
      .click();
    const folderName = sidebar.getByRole("textbox", {
      name: "New folder name",
      exact: true,
    });
    await folderName.fill("Plans");
    await folderName.press("Enter");
    await expect(
      sidebar.getByRole("link", { name: "Plans", exact: true }),
    ).toBeVisible();

    await sidebar
      .getByRole("button", { name: "Collapse Threads", exact: true })
      .click();
    await expect(
      sidebar.getByRole("button", { name: "Expand Threads", exact: true }),
    ).toBeVisible();
    await dragSection(sidebar, "Threads", "Collapse Artifacts", [
      "Favorites",
      "Threads",
      "Artifacts",
    ]);
    await sidebar
      .getByRole("button", { name: "Reorder Threads", exact: true })
      .press("ArrowUp");
    await expect(
      sidebar.getByRole("button", { name: sectionHeaders }),
    ).toHaveText(["Threads", "Favorites", "Artifacts"]);
    await sidebar
      .getByRole("button", { name: "Reorder Threads", exact: true })
      .press("ArrowDown");
    await expect(
      sidebar.getByRole("button", { name: sectionHeaders }),
    ).toHaveText(["Favorites", "Threads", "Artifacts"]);
  },
);

function workspaceSidebar(page: Page) {
  return page.getByRole("navigation", { name: "Workspace", exact: true });
}

async function chooseFilter(page: Page, label: string) {
  await workspaceSidebar(page)
    .getByRole("button", { name: "Filter artifacts", exact: true })
    .click();
  // Maui appends a checkmark to the selected option's accessible name.
  await page
    .getByRole("menuitemradio", { name: new RegExp(`^${label}`) })
    .click();
}

// Playwright's first HTML drag in a fresh Electron page can dispatch no drag
// events, so the drag is retried until the order changes.
async function dragSection(
  sidebar: Locator,
  section: string,
  target: string,
  order: string[],
) {
  await expect(async () => {
    await sidebar
      .getByRole("button", { name: `Reorder ${section}`, exact: true })
      .dragTo(sidebar.getByRole("button", { name: target, exact: true }));
    await expect(
      sidebar.getByRole("button", { name: sectionHeaders }),
    ).toHaveText(order, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
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
            sectionOrder: ["favorites", "artifacts", "sessions"],
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
