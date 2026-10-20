import { expect, type Locator } from "@playwright/test";
import path from "node:path";
import { e2eTest } from "../e2eTest.js";

e2eTest.setTimeout(120_000);
const SECTIONS = /^(Collapse|Expand) (Favorites|Artifacts|Sessions)$/;

// Playwright's first HTML drag in a fresh Electron page dispatches no drag events, so retry.
async function dragSection(sidebar: Locator, section: string, target: string, order: string[]) {
  await expect(async () => {
    await sidebar.getByRole("button", { name: `Reorder ${section}`, exact: true }).dragTo(sidebar.getByRole("button", { name: target, exact: true }));
    await expect(sidebar.getByRole("button", { name: SECTIONS })).toHaveText(order, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}
const screenshots = path.resolve(
  import.meta.dirname,
  "../../../..",
  ".context",
);

e2eTest(
  "favorites persist, navigate, follow renames, and work on mobile",
  async ({ app, harness }) => {
    await app.page.emulateMedia({ reducedMotion: "reduce" });
    await app.page.setViewportSize({ width: 1440, height: 1000 });
    await harness.tools.files.write({
      path: "Project brief.md",
      content: "# Project brief\nA workspace document.",
    });
    await app.server.rpc.workspace.createEntry({ path: "Research", kind: "directory" });
    await harness.tools.files.write({
      path: "Research/Findings.md",
      content: "# Findings\nSome research.",
    });
    const sidebar = app.page.getByRole("navigation", {
      name: "Workspace",
      exact: true,
    });
    const toolbar = sidebar.getByRole("toolbar", { name: "Workspace actions" });
    await expect(sidebar.getByRole("link", { name: "Desktop", exact: true })).toHaveCount(0);
    await toolbar.getByRole("button", { name: "Desktop", exact: true }).click();
    await expect(app.page.getByRole("region", { name: "Desktop", exact: true })).toBeVisible();
    await toolbar.getByRole("button", { name: "New chat session", exact: true }).click();
    await expect(app.page.getByRole("main", { name: "New session", exact: true })).toBeVisible();
    await toolbar.getByRole("button", { name: "New Markdown file", exact: true }).click();
    await sidebar.getByRole("textbox", { name: "New file name", exact: true }).fill("Meeting notes");
    await sidebar.getByRole("textbox", { name: "New file name", exact: true }).press("Enter");
    await expect(sidebar.getByRole("link", { name: "Meeting notes.md", exact: true })).toBeVisible();
    await sidebar.getByRole("button", { name: "Collapse Artifacts", exact: true }).click();
    await expect(sidebar.getByRole("link", { name: "Meeting notes.md", exact: true })).toHaveCount(0);
    await toolbar.getByRole("button", { name: "New folder", exact: true }).click();
    await sidebar.getByRole("textbox", { name: "New folder name", exact: true }).fill("Planning");
    await sidebar.getByRole("textbox", { name: "New folder name", exact: true }).press("Enter");
    await expect(sidebar.getByRole("link", { name: "Planning", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "New session", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: "New file", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: "New automation", exact: true })).toHaveCount(0);
    await sidebar.getByRole("button", { name: "Collapse Sessions", exact: true }).click();
    await dragSection(sidebar, "Sessions", "Collapse Artifacts", ["Favorites", "Sessions", "Artifacts"]);
    await sidebar.getByRole("button", { name: "Reorder Sessions", exact: true }).press("ArrowDown");
    await expect(sidebar.getByRole("button", { name: SECTIONS })).toHaveText(["Favorites", "Artifacts", "Sessions"]);
    await app.page.reload();
    await expect(sidebar.getByRole("button", { name: "Expand Sessions", exact: true })).toBeVisible();
    const favorites = sidebar.getByRole("rowgroup", {
      name: "Favorites",
      exact: true,
    });
    await expect(
      sidebar.getByText("Star an item to keep it here."),
    ).toBeVisible();
    await app.page.screenshot({
      animations: "disabled",
      path: path.join(screenshots, "favorites-empty-desktop.png"),
    });
    await sidebar
      .getByRole("link", { name: "Project brief.md", exact: true })
      .hover();
    await sidebar
      .getByRole("button", {
        name: "Add Project brief.md to favorites",
        exact: true,
      })
      .click();
    await expect(
      favorites.getByRole("link", { name: "Project brief.md", exact: true }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("link", { name: "Project brief.md", exact: true }),
    ).toHaveCount(2);
    await favorites
      .getByRole("link", { name: "Project brief.md", exact: true })
      .click();
    await expect(
      app.page.getByRole("main", { name: "Project brief.md", exact: true }),
    ).toBeVisible();
    await app.page.addInitScript(() => {
      new MutationObserver(() => {
        if (document.querySelector('nav[aria-label="Workspace"]')?.textContent?.includes("Unavailable")) document.documentElement.dataset.sawUnavailable = "true";
      }).observe(document, {childList: true, subtree: true, characterData: true});
    });
    await app.page.reload();
    await expect(
      favorites.getByRole("link", { name: "Project brief.md", exact: true }),
    ).toBeVisible();
    await expect(app.page.locator("html")).not.toHaveAttribute("data-saw-unavailable", "true");
    await sidebar
      .getByRole("link", { name: "Project brief.md", exact: true })
      .last()
      .hover();
    await sidebar
      .getByRole("button", {
        name: "Actions for Project brief.md",
        exact: true,
      })
      .click();
    await app.page
      .getByRole("menuitem", { name: "Rename…", exact: true })
      .click();
    await app.page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Product brief.md");
    await app.page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(
      favorites.getByRole("link", { name: "Product brief.md", exact: true }),
    ).toBeVisible();
    await expect(
      favorites.getByRole("link", { name: "Project brief.md", exact: true }),
    ).toHaveCount(0);
    const research = sidebar.getByRole("row", {
      name: "Research",
      exact: true,
    });
    await research.hover();
    await research
      .getByRole("button", { name: "Add Research to favorites", exact: true })
      .click();
    await favorites
      .getByRole("row", { name: "Research", exact: true })
      .getByRole("button", { name: "Expand Research", exact: true })
      .click();
    await expect(
      favorites.getByRole("link", { name: "Findings.md", exact: true }),
    ).toBeVisible();
    await favorites
      .getByRole("link", { name: "Findings.md", exact: true })
      .hover();
    await favorites
      .getByRole("button", {
        name: "Add Findings.md to favorites",
        exact: true,
      })
      .click();
    await expect(
      favorites.getByRole("link", { name: "Findings.md", exact: true }),
    ).toHaveCount(2);
    await app.page.screenshot({
      animations: "disabled",
      path: path.join(screenshots, "favorites-desktop.png"),
    });
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.page
      .getByRole("button", { name: "Open sidebar", exact: true })
      .click();
    await expect(
      favorites.getByRole("link", { name: "Product brief.md", exact: true }),
    ).toBeVisible();
    await app.page.getByRole("dialog", { name: "Workspace navigation" }).evaluate(async (element) => { await Promise.all(element.getAnimations({subtree: true}).map((animation) => animation.finished)); });
    await app.page.screenshot({
      animations: "disabled",
      path: path.join(screenshots, "favorites-mobile.png"),
    });
    await favorites
      .getByRole("button", {
        name: "Remove Product brief.md from favorites",
        exact: true,
      })
      .click();
    await expect(
      favorites.getByRole("link", { name: "Product brief.md", exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("link", { name: "Product brief.md", exact: true }),
    ).toBeVisible();
    await favorites
      .getByRole("link", { name: "Findings.md", exact: true }).first()
      .click();
    await expect(
      app.page.getByRole("dialog", { name: "Workspace navigation" }),
    ).toHaveCount(0);
    await app.page.setViewportSize({width: 1440, height: 1000});
    await app.server.rpc.workspace.deleteEntry({path: "Research/Findings.md"});
    await expect(favorites.getByRole("status")).toHaveText("Unavailable");
    await favorites.getByRole("button", {name: "Remove Findings.md from favorites", exact: true}).click();
    await expect(favorites.getByRole("status")).toHaveCount(0);

  },
);

e2eTest("favorites open extensions, automations, and completed sessions", async ({ app, harness }) => {
  await harness.loadExtension("../fixtures/greeting");
  const session = await harness.loadSession({ title: "Planning discussion", messages: [{type: "user", text: "Plan the next release."}] });
  await app.server.rpc.automations.save({
    name: "Morning briefing", enabled: false,
    activation: {type: "routine", schedule: {cron: "0 8 * * *", timezone: "UTC"}},
    action: {type: "runAgent", prompt: "Summarize my day."},
  });
  const sidebar = app.page.getByRole("navigation", {name: "Workspace", exact: true});
  const favorites = sidebar.getByRole("rowgroup", {name: "Favorites", exact: true});
  for (const title of ["greeting", "Morning briefing", "Planning discussion"]) {
    await sidebar.getByRole("link", { name: title, exact: true }).hover();
    await sidebar.getByRole("button", {name: `Add ${title} to favorites`, exact: true}).click();
    await expect(favorites.getByRole("link", {name: title, exact: true})).toBeVisible();
  }
  await favorites.getByRole("link", {name: "greeting", exact: true}).click();
  await expect(app.page.locator('iframe[title="greeting"]').contentFrame().getByRole("textbox", {name: "Your name"})).toBeVisible();
  await favorites.getByRole("link", {name: "Morning briefing", exact: true}).click();
  await expect(app.page.getByRole("region", {name: "Automation Morning briefing", exact: true})).toContainText("Summarize my day.");
  await app.server.rpc.thread.markDone({sessionId: session.sessionId});
  await favorites.getByRole("link", {name: "Planning discussion", exact: true}).click();
  await expect(app.page.getByRole("main", {name: "Planning discussion", exact: true})).toBeVisible();
  await app.page.reload();
  await expect(favorites.getByRole("link")).toHaveCount(3);
  await sidebar.getByRole("button", {name: "Collapse Artifacts", exact: true}).click();
  await expect(sidebar.getByRole("rowgroup", {name: "Artifacts", exact: true}).getByRole("link")).toHaveCount(0);
  await expect(favorites.getByRole("link", {name: "greeting", exact: true})).toBeVisible();

  // A favorited extension expands to its own automations, independently of Artifacts.
  await app.server.rpc.automations.save({
    extensionId: "greeting", name: "Send greetings", enabled: true,
    activation: {type: "routine", schedule: {cron: "0 8 * * *", timezone: "UTC"}},
    action: {type: "runScript", command: "echo hello"},
  });
  await sidebar.getByRole("button", {name: "Expand Artifacts", exact: true}).click();
  const artifacts = sidebar.getByRole("rowgroup", {name: "Artifacts", exact: true});
  await favorites.getByRole("row", {name: "greeting", exact: true}).getByRole("button", {name: "Expand greeting", exact: true}).click();
  await expect(favorites.getByRole("link", {name: "Send greetings", exact: true})).toBeVisible();
  await expect(artifacts.getByRole("link", {name: "Send greetings", exact: true})).toHaveCount(0);
  await favorites.getByRole("link", {name: "Send greetings", exact: true}).click();
  await expect(app.page.getByRole("region", {name: "Automation Send greetings", exact: true})).toBeVisible();
});

e2eTest("quick actions and section controls work without reloading", async ({ app }) => {
  const sidebar = app.page.getByRole("navigation", {name: "Workspace", exact: true});
  const toolbar = sidebar.getByRole("toolbar", {name: "Workspace actions"});
  await toolbar.getByRole("button", {name: "Desktop", exact: true}).click();
  await expect(app.page.getByRole("region", {name: "Desktop", exact: true})).toBeVisible();
  await toolbar.getByRole("button", {name: "New chat session", exact: true}).click();
  await expect(app.page.getByRole("main", {name: "New session", exact: true})).toBeVisible();
  await toolbar.getByRole("button", {name: "New Markdown file", exact: true}).click();
  const filename = sidebar.getByRole("textbox", {name: "New file name", exact: true});
  await filename.fill("Quick note");
  await filename.press("Enter");
  await expect(sidebar.getByRole("link", {name: "Quick note.md", exact: true})).toBeVisible();
  await toolbar.getByRole("button", {name: "New folder", exact: true}).click();
  const folder = sidebar.getByRole("textbox", {name: "New folder name", exact: true});
  await folder.fill("Plans");
  await folder.press("Enter");
  await expect(sidebar.getByRole("link", {name: "Plans", exact: true})).toBeVisible();
  await dragSection(sidebar, "Artifacts", "Collapse Favorites", ["Artifacts", "Favorites", "Sessions"]);
  await sidebar.getByRole("button", {name: "Reorder Artifacts", exact: true}).press("ArrowDown");
  await expect(sidebar.getByRole("button", {name: SECTIONS})).toHaveText(["Favorites", "Artifacts", "Sessions"]);
});

e2eTest("artifacts mix every kind and filter from the header menu", async ({ app, harness }) => {
  await app.page.emulateMedia({ reducedMotion: "reduce" });
  await app.page.setViewportSize({ width: 1440, height: 1000 });
  await harness.loadExtension("../fixtures/greeting");
  await harness.tools.files.write({ path: "Product brief.md", content: "# Product brief" });
  await app.server.rpc.automations.save({
    name: "Morning briefing", enabled: true,
    activation: {type: "routine", schedule: {cron: "0 8 * * *", timezone: "UTC"}},
    action: {type: "runAgent", prompt: "Summarize my day."},
  });
  const sidebar = app.page.getByRole("navigation", {name: "Workspace", exact: true});
  const artifacts = sidebar.getByRole("rowgroup", {name: "Artifacts", exact: true});
  const names = ["greeting", "Morning briefing", "Product brief.md"];
  await expect(artifacts.getByRole("link")).toHaveText(names);
  await expect(sidebar.getByRole("button", {name: /^(Collapse|Expand) (Automations|Extensions|Documents)$/})).toHaveCount(0);

  // A favorite has no resting star; the toggle appears on hover.
  const brief = artifacts.getByRole("row", {name: "Product brief.md", exact: true});
  await brief.hover();
  await brief.getByRole("button", {name: "Add Product brief.md to favorites", exact: true}).click();
  const toggle = brief.getByRole("button", {name: "Remove Product brief.md from favorites", exact: true});
  await toggle.blur();
  await app.page.mouse.move(900, 500);
  await expect(toggle).toHaveCSS("opacity", "0");
  await app.page.screenshot({ animations: "disabled", path: path.join(screenshots, "artifacts-desktop.png") });

  const filter = sidebar.getByRole("button", {name: "Filter artifacts", exact: true});
  async function choose(label: string) {
    await filter.click();
    await app.page.getByRole("menuitemradio", {name: label, exact: true}).click();
  }
  await filter.click();
  await expect(app.page.getByRole("menuitemradio", {name: /^All/})).toHaveAttribute("aria-checked", "true");
  await app.page.screenshot({ animations: "disabled", path: path.join(screenshots, "artifacts-filter-menu.png") });
  await app.page.keyboard.press("Escape");
  await choose("Extensions");
  await expect(artifacts.getByRole("link")).toHaveText(["greeting"]);
  await choose("Automations");
  await expect(artifacts.getByRole("link")).toHaveText(["Morning briefing"]);
  await choose("Docs");
  await expect(artifacts.getByRole("link")).toHaveText(["Product brief.md"]);
  await app.page.reload();
  await expect(artifacts.getByRole("link")).toHaveText(["Product brief.md"]);

  // Creating a file while files are filtered out reveals them again.
  await choose("Extensions");
  await sidebar.getByRole("toolbar", {name: "Workspace actions"}).getByRole("button", {name: "New Markdown file", exact: true}).click();
  await expect(sidebar.getByRole("textbox", {name: "New file name", exact: true})).toBeVisible();
  await app.page.keyboard.press("Escape");
  await expect(artifacts.getByRole("link")).toHaveText(names);

  await app.page.setViewportSize({ width: 390, height: 844 });
  await app.page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  const drawer = app.page.getByRole("dialog", { name: "Workspace navigation" });
  await drawer.evaluate(async (element) => { await Promise.all(element.getAnimations({subtree: true}).map((animation) => animation.finished)); });
  await app.page.screenshot({ animations: "disabled", path: path.join(screenshots, "artifacts-mobile.png") });
});

e2eTest("artifact filters show an empty state per kind", async ({ app }) => {
  const sidebar = app.page.getByRole("navigation", {name: "Workspace", exact: true});
  await expect(sidebar.getByText("No artifacts yet")).toBeVisible();
  await sidebar.getByRole("button", {name: "Filter artifacts", exact: true}).click();
  await app.page.getByRole("menuitemradio", {name: "Automations", exact: true}).click();
  await expect(sidebar.getByText("No automations yet")).toBeVisible();
});

e2eTest("the Artifacts empty state waits for the file listing", async ({ app, harness }) => {
  await harness.tools.files.write({ path: "Only file.md", content: "# Only file" });
  const sidebar = app.page.getByRole("navigation", {name: "Workspace", exact: true});
  await expect(sidebar.getByRole("link", {name: "Only file.md", exact: true})).toBeVisible();
  await app.page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector('nav[aria-label="Workspace"]')?.textContent?.includes("No artifacts yet")) document.documentElement.dataset.sawEmpty = "true";
    }).observe(document, {childList: true, subtree: true, characterData: true});
  });
  await app.page.reload();
  await expect(sidebar.getByRole("link", {name: "Only file.md", exact: true})).toBeVisible();
  await expect(app.page.locator("html")).not.toHaveAttribute("data-saw-empty", "true");
});

e2eTest("a favorited extension that is not running keeps its automations", async ({ app }) => {
  await app.server.rpc.automations.save({
    extensionId: "stopped-app", name: "Nightly sync", enabled: true,
    activation: {type: "routine", schedule: {cron: "0 2 * * *", timezone: "UTC"}},
    action: {type: "runScript", command: "echo sync"},
  });
  const sidebar = app.page.getByRole("navigation", {name: "Workspace", exact: true});
  const favorites = sidebar.getByRole("rowgroup", {name: "Favorites", exact: true});
  const artifacts = sidebar.getByRole("rowgroup", {name: "Artifacts", exact: true});
  const row = artifacts.getByRole("row", {name: /^stopped-app/});
  await expect(row).toContainText("Not running");
  await row.hover();
  await row.getByRole("button", {name: "Add stopped-app to favorites", exact: true}).click();
  const favorite = favorites.getByRole("row", {name: /^stopped-app/});
  await expect(favorite).toContainText("Not running");
  await app.page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector('nav[aria-label="Workspace"] [role="rowgroup"][aria-label="Favorites"]')?.textContent?.includes("Unavailable")) document.documentElement.dataset.sawUnavailable = "true";
    }).observe(document, {childList: true, subtree: true, characterData: true});
  });
  await app.page.reload();
  await favorite.getByRole("button", {name: "Expand stopped-app", exact: true}).click();
  await expect(favorites.getByRole("link", {name: "Nightly sync", exact: true})).toBeVisible();
  await expect(app.page.locator("html")).not.toHaveAttribute("data-saw-unavailable", "true");
});
