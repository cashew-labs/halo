import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.test.ts",
  fullyParallel: true,
  // Coverage slows every process, so code-review-agent runs get more time.
  timeout: process.env.REVIEW_COVERAGE_DIR ? 90_000 : 30_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: path.resolve(import.meta.dirname, "../../tmp/e2e/playwright"),
});
