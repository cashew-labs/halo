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

test("generated unrelated flow supports selection, local editing, reset and navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const outline = page.getByRole("navigation", { name: "Flow outline" });
  const preview = page.getByRole("complementary", {
    name: "Selected state preview",
  });
  await expect(outline.getByRole("button")).toHaveCount(2);
  await expect(
    page.getByRole("navigation", { name: "Flow states" }).getByRole("button"),
  ).toHaveCount(2);
  const name = preview.getByRole("textbox", { name: "Digest name" });
  await name.fill("My changes");
  await preview
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(preview.getByRole("status")).toHaveText("Preferences saved");
  await preview.getByRole("button", { name: "Reset preview" }).click();
  await expect(name).toHaveValue("Morning digest");
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
  await preview.getByRole("button", { name: "Previous state" }).click();
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

test("reviews synchronize in all three surfaces and survive drafts, reset, theme and reload", async ({
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
  await preview.getByRole("button", { name: "Reset preview" }).click();
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

for (const change of ["content", "style"] as const) {
  test(`only the changed state's ${change} invalidates its review`, async ({
    page,
  }) => {
    const review = (title: string) =>
      page
        .getByRole("group", { name: `Review in tree: ${title}`, exact: true })
        .getByRole("checkbox");
    for (const title of ["Editing preferences", "Preferences saved"]) {
      await review(title).locator("xpath=ancestor::label").click();
      await expect(review(title)).toBeChecked();
    }
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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle flow sidebar" }).click();
  await expect(
    page.getByRole("navigation", { name: "Flow outline" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("complementary").getByRole("textbox"),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("narrow.png") });
});
