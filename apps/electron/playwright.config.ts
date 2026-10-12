import { registerHooks } from "node:module";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Tandem 0.3.0 ships extensionless relative imports in its published JavaScript.
// Resolve only that dependency; leave Playwright's test transformation unchanged.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      /\/@tanishqkancharla\/tandem-(core|server)\//u.test(
        context.parentURL ?? "",
      ) &&
      (specifier.startsWith(".") || specifier.startsWith("tuple-database/")) &&
      path.extname(specifier) === ""
    )
      return nextResolve(`${specifier}.js`, context);
    return nextResolve(specifier, context);
  },
});

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
