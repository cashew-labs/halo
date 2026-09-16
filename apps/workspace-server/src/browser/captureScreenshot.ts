import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { BrowserError, type BrowserPage } from "./BrowserPage.js";

export async function captureScreenshot(ctx: {
  view: BrowserPage;
  workspaceRoot: string;
}) {
  const { view, workspaceRoot } = ctx;
  const directory = join(workspaceRoot, ".halo", "browser", "screenshots");
  const made = await fs
    .mkdir(directory, { recursive: true })
    .catch(
      (cause) =>
        new BrowserError({ detail: "create screenshots directory", cause }),
    );
  if (made instanceof Error) return made;
  return await view.screenshot(join(directory, `${randomUUID()}.png`));
}
