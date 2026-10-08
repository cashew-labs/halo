import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright";

// code-review-agent sets REVIEW_COVERAGE_DIR only while it collects coverage.
// Outside its runs every helper here is a no-op, so tests behave as before.
const coverageDirectory = process.env.REVIEW_COVERAGE_DIR;

export async function startPageCoverage(page: Page): Promise<void> {
  if (coverageDirectory === undefined) return;
  // resetOnNavigation: false keeps coverage across in-test reloads (such as loadSession).
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
}

export async function stopPageCoverage(page: Page): Promise<void> {
  if (coverageDirectory === undefined || page.isClosed()) return;
  const entries = await page.coverage.stopJSCoverage();
  await writeFile(
    path.join(coverageDirectory, `${randomUUID()}.json`),
    JSON.stringify(entries),
  );
}

export async function flushMainCoverage(
  app: ElectronApplication,
): Promise<void> {
  if (coverageDirectory === undefined) return;
  // The main process may be killed on teardown; write its coverage now, while it runs.
  await app.evaluate(() => {
    process.getBuiltinModule("node:v8").takeCoverage();
  });
}
