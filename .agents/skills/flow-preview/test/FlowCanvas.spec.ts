import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { expect } from "@playwright/test";
import { test } from "./fixtures.js";

test.beforeEach(async ({ page, preview }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${preview.origin}/?theme=light`);
});

test("generator refuses existing previews and unsafe names without overwriting", async ({
  preview,
}) => {
  const generator = url.fileURLToPath(
    new URL("../scripts/generate.mjs", import.meta.url),
  );
  for (const args of [[preview.name], ["../escape"], ["valid-name", "80"]]) {
    const generated = childProcess.spawnSync(
      process.execPath,
      [generator, ...args],
      { cwd: preview.project, encoding: "utf8" },
    );
    expect(generated.status).toBe(1);
    expect(generated.stderr).not.toBe("");
  }
});

test("portal serves opted-in source but denies runtime data and credentials", async ({
  page,
  request,
  preview,
}) => {
  await expect(
    page.getByRole("complementary").getByRole("textbox"),
  ).toHaveValue("Morning digest");
  const source = await request.get(
    `${preview.origin}/@fs/${preview.project}/src/settings.ts`,
  );
  expect(source.status()).toBe(200);
  expect(await source.text()).toContain("Morning digest");
  const directory = path.join(preview.project, "tmp", preview.name);
  const blocked = [
    path.join(preview.project, "private-notes.txt"),
    ...["server.json", "rpc.json", "state.db"].map((file) =>
      path.join(preview.project, "tmp/workspace/.halo", file),
    ),
    ...[
      ".env",
      ".env.local",
      "private.key",
      ".git/config",
      ".halo/state.db",
      ".amp/credentials.json",
    ].map((file) => path.join(preview.project, "src", file)),
    path.join(directory, ".halo", "server.json"),
  ];
  for (const file of blocked) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "private-preview-sentinel");
    for (const query of ["?import", "", "?raw", "?raw&import", "?url&import"]) {
      const response = await request.get(
        `${preview.origin}/@fs/${file}${query}`,
      );
      expect(await response.text(), file + query).not.toContain(
        "private-preview-sentinel",
      );
      // Vite can return a URL-only asset module for ?import, never file contents.
      if (query !== "?import")
        expect(response.status(), file + query).toBe(403);
    }
  }
  const rootRelative = await request.get(`${preview.origin}/.halo/server.json`);
  expect(rootRelative.status()).toBe(403);
  expect(await rootRelative.text()).not.toContain("private-preview-sentinel");
});

test("generated unrelated flow supports selection, local editing, breadcrumbs and navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const outline = page.getByRole("navigation", { name: "Flow outline" });
  const preview = page.getByRole("complementary", {
    name: "Selected state preview",
  });
  const breadcrumbs = preview.getByRole("navigation", { name: "State path" });
  await page.setViewportSize({ width: 1280, height: 600 });
  await expect(
    preview.getByRole("button", { name: "Follow flow: Save preferences" }),
  ).toBeInViewport();
  await expect(outline.getByRole("button")).toHaveCount(2);
  await expect(
    page.getByRole("navigation", { name: "Flow states" }).getByRole("button"),
  ).toHaveCount(2);
  const name = preview.getByRole("textbox", { name: "Digest name" });
  await name.fill("My changes");
  await page
    .getByRole("button", { name: "Preview Preferences saved", exact: true })
    .hover();
  await expect(name).toHaveValue("My changes");
  await expect(
    preview.getByRole("heading", { name: "Editing preferences", exact: true }),
  ).toBeVisible();
  await preview
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(preview.getByRole("status")).toHaveText("Preferences saved");
  await breadcrumbs
    .getByRole("button", { name: "Editing preferences", exact: true })
    .click();
  await expect(name).toHaveValue("Morning digest");
  await expect(name).toBeInViewport();
  await expect(preview.getByRole("status")).toHaveCount(0);
  await preview
    .getByRole("button", { name: "Follow flow: Save preferences" })
    .click();
  await expect(
    preview.getByRole("heading", { name: "Preferences saved" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Preview Preferences saved" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(preview.getByRole("textbox")).toHaveCount(1);
  await expect(breadcrumbs.getByRole("button")).toHaveText([
    "Editing preferences",
    "Preferences saved",
  ]);
  await expect(
    breadcrumbs.getByRole("button", { name: "Preferences saved", exact: true }),
  ).toHaveAttribute("aria-current", "step");
  await breadcrumbs
    .getByRole("button", { name: "Editing preferences", exact: true })
    .click();
  await expect(breadcrumbs.getByRole("button")).toHaveText([
    "Editing preferences",
    "Preferences saved",
  ]);
  await expect(
    breadcrumbs.getByRole("button", {
      name: "Editing preferences",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "step");
  await expect(
    breadcrumbs.getByRole("button", { name: "Preferences saved", exact: true }),
  ).not.toHaveAttribute("aria-current", "step");
  await expect(name).toHaveValue("Morning digest");
  await breadcrumbs
    .getByRole("button", { name: "Preferences saved", exact: true })
    .click();
  await expect(preview.getByRole("status")).toHaveText("Preferences saved");
  await preview.getByRole("button", { name: "Previous state" }).click();
  await expect(breadcrumbs.getByRole("button")).toHaveText([
    "Editing preferences",
    "Preferences saved",
  ]);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByText("95%", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Toggle flow sidebar" }).click();
  await expect(outline).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Toggle flow sidebar" }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Toggle flow sidebar" }).click();
  await expect(outline).toBeVisible();
  expect(errors).toEqual([]);
});

test("breadcrumbs retain a journey across navigation and replace it on a different branch", async ({
  page,
}) => {
  await page.route("**/scenario.tsx*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const body = original.replace(
      /(\{\s*id: "saved",)/,
      `{ id: "discarded", title: "Changes discarded", parent: "editing",
         action: "Discard changes", row: 1, render: () => null }, $1`,
    );
    expect(body).not.toBe(original);
    await route.fulfill({ response, body });
  });
  await page.reload();
  const preview = page.getByRole("complementary");
  const breadcrumbs = preview.getByRole("navigation", { name: "State path" });
  const outline = page.getByRole("navigation", { name: "Flow outline" });
  await outline
    .getByRole("button", { name: "Preferences saved", exact: true })
    .click();
  await breadcrumbs
    .getByRole("button", { name: "Editing preferences", exact: true })
    .click();
  await expect(breadcrumbs.getByRole("button")).toHaveText([
    "Editing preferences",
    "Preferences saved",
  ]);
  await preview
    .getByRole("button", { name: "Follow flow: Discard changes" })
    .click();
  await expect(breadcrumbs.getByRole("button")).toHaveText([
    "Editing preferences",
    "Changes discarded",
  ]);
  await expect(
    preview.getByRole("heading", { name: "Changes discarded", exact: true }),
  ).toBeVisible();
  await outline
    .getByRole("button", { name: "Editing preferences", exact: true })
    .click();
  await expect(breadcrumbs.getByRole("button")).toHaveText([
    "Editing preferences",
    "Changes discarded",
  ]);
  await preview
    .getByRole("button", { name: "Follow flow: Save preferences" })
    .click();
  await expect(breadcrumbs.getByRole("button")).toHaveText([
    "Editing preferences",
    "Preferences saved",
  ]);
});

test("both sidebar widths persist after dragging, keyboard resizing and reload", async ({
  page,
}) => {
  const outline = page.getByRole("separator", { name: "Resize flow outline" });
  const preview = page.getByRole("separator", { name: "Resize state preview" });
  for (const [handle, delta, expected] of [
    [outline, 76, "324"],
    [preview, -100, "534"],
  ] as const) {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + delta, box.y + 80, {
      steps: 10,
    });
    await page.mouse.up();
    await expect(handle).toHaveAttribute("aria-valuenow", expected);
  }
  await preview.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(preview).toHaveAttribute("aria-valuenow", "550");
  await page.reload();
  await expect(outline).toHaveAttribute("aria-valuenow", "324");
  await expect(preview).toHaveAttribute("aria-valuenow", "550");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(outline).toBeHidden();
  await expect(preview).toBeHidden();
  await expect(
    page.getByRole("separator", {
      name: "Resize flow outline",
      includeHidden: true,
    }),
  ).toHaveAttribute("aria-valuenow", "324");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(outline).toHaveAttribute("aria-valuenow", "324");
  await expect(preview).toHaveAttribute("aria-valuenow", "550");
});

test("sparse row hints keep adjacent columns visible without invalidating reviews", async ({
  page,
}) => {
  const review = page
    .getByRole("group", {
      name: "Review in tree: Editing preferences",
      exact: true,
    })
    .getByRole("checkbox");
  await review.locator("xpath=ancestor::label").click();
  await expect(review).toBeChecked();
  await page.route("**/scenario.tsx*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const body = original
      .replace("row: 0", "row: 40")
      .replace("row: 0", "row: 400");
    expect(body).not.toBe(original);
    await route.fulfill({ response, body });
  });
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Preview Editing preferences",
      exact: true,
    }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", {
      name: "Preview Preferences saved",
      exact: true,
    }),
  ).toBeInViewport();
  await expect(review).toBeChecked();
});

test("reviews synchronize in all three surfaces and survive drafts, breadcrumbs, theme and reload", async ({
  page,
  preview: flow,
}) => {
  const preview = page.getByRole("complementary");
  const treeReview = page
    .getByRole("group", {
      name: "Review in tree: Editing preferences",
      exact: true,
    })
    .getByRole("checkbox");
  const canvasReview = page
    .getByRole("group", { name: "Review Editing preferences", exact: true })
    .getByRole("checkbox");
  const review = preview.getByRole("checkbox", { name: "Reviewed" });
  const mark = page.getByRole("img", {
    name: "Reviewed: Editing preferences",
    exact: true,
  });
  await expect(mark).toHaveCount(0);
  await treeReview.locator("xpath=ancestor::label").click();
  await expect(review).toBeChecked();
  await expect(canvasReview).toBeChecked();
  await expect(mark).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Reviewed: Preferences saved", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Preview Editing preferences", exact: true })
    .click();
  await expect(review).toBeChecked();
  await preview.getByRole("textbox").fill("Unsaved draft");
  await preview
    .getByRole("navigation", { name: "State path" })
    .getByRole("button", { name: "Editing preferences", exact: true })
    .click();
  await expect(preview.getByRole("textbox")).toHaveValue("Morning digest");
  await expect(review).toBeChecked();
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(review).toBeChecked();
  await page.goto(`${flow.origin}/?theme=dark`);
  await expect(review).toBeChecked();
  await expect(mark).toBeVisible();
  await canvasReview.locator("xpath=ancestor::label").click();
  await expect(treeReview).not.toBeChecked();
  await expect(mark).toHaveCount(0);
  await page.reload();
  await expect(review).not.toBeChecked();
  await expect(mark).toHaveCount(0);
});

test("mark all reviews every state, persists on reload and allows individual unchecking", async ({
  page,
}) => {
  const bulkReview = page.getByRole("button", { name: "Mark all as reviewed" });
  const outline = page.getByRole("navigation", { name: "Flow outline" });
  const firstReview = outline.getByRole("checkbox").first();
  await expect(bulkReview).toBeEnabled();
  await firstReview.locator("xpath=ancestor::label").click();
  await bulkReview.click();
  for (const review of await page.getByRole("checkbox").all()) {
    await expect(review).toBeChecked();
  }
  await expect(bulkReview).toBeDisabled();
  await page.reload();
  await expect(bulkReview).toBeDisabled();
  for (const review of await page.getByRole("checkbox").all()) {
    await expect(review).toBeChecked();
  }
  await firstReview.locator("xpath=ancestor::label").click();
  await expect(bulkReview).toBeEnabled();
  await page.reload();
  await expect(firstReview).not.toBeChecked();
  await expect(outline.getByRole("checkbox").last()).toBeChecked();
});

for (const change of ["content", "style"] as const) {
  test(`only the changed state's ${change} invalidates its review`, async ({
    page,
  }) => {
    const review = (title: string) =>
      page
        .getByRole("group", { name: `Review in tree: ${title}`, exact: true })
        .getByRole("checkbox");
    await page.getByRole("button", { name: "Mark all as reviewed" }).click();
    await expect(review("Editing preferences")).toBeChecked();
    await expect(review("Preferences saved")).toBeChecked();
    await page.reload();
    await expect(review("Preferences saved")).toBeChecked();
    await page.route("**/scenario.tsx*", async (route) => {
      const response = await route.fetch();
      const original = await response.text();
      const body =
        change === "content"
          ? original.replaceAll("Preferences saved", "Delivery ready")
          : original.replace("minHeight: 260", "minHeight: saved ? 261 : 260");
      expect(body).not.toBe(original);
      await route.fulfill({ response, body });
    });
    await page.reload();
    await expect(review("Editing preferences")).toBeChecked();
    await expect(
      review(change === "content" ? "Delivery ready" : "Preferences saved"),
    ).not.toBeChecked();
  });
}

test("generic canvas renders light, dark and narrow without duplicate IDs", async ({
  page,
}, testInfo) => {
  const ids = await page
    .locator("[id]")
    .evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(ids).size).toBe(ids.length);
  await page.screenshot({ path: testInfo.outputPath("light.png") });
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: testInfo.outputPath("dark.png") });
  await page.route("**/scenario.tsx*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const body = original.replace(
      'title: "Editing preferences",',
      `title: "Editing preferences", note: ${JSON.stringify("This state has extra context so the preview must remain usable below its breadcrumbs and explanation. ".repeat(6))},`,
    );
    expect(body).not.toBe(original);
    await route.fulfill({ response, body });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "Toggle flow sidebar" }).click();
  await expect(
    page.getByRole("navigation", { name: "Flow outline" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("complementary").getByRole("textbox"),
  ).toBeVisible();
  const preview = page.getByRole("complementary");
  await preview
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(preview.getByRole("status")).toHaveText("Preferences saved");
  await expect(preview.getByRole("textbox")).toBeInViewport({ ratio: 1 });
  await expect(
    preview.getByRole("button", { name: "Save preferences", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("narrow.png") });
});
