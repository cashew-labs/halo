import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * Vitest `test` options for one package, split by `REVIEW_TEST_TIER`.
 *
 * Unset or `durable` runs the committed tests, as before. `tmp` runs only the
 * package's gitignored `.tmp-tests/` files. `--coverage` writes lcov with
 * repo-relative paths to `<package>/.tmp-tests/coverage/lcov.info`.
 *
 * This file imports nothing from Vitest, so each package keeps using its own
 * Vitest version through `defineConfig`.
 */
export function testTierOptions(...excludedTests: string[]) {
  const tier = process.env.REVIEW_TEST_TIER;
  if (tier !== undefined && tier !== "durable" && tier !== "tmp") {
    throw new Error(
      `REVIEW_TEST_TIER must be "durable" or "tmp", received "${tier}".`,
    );
  }
  return {
    // Vitest's default include and exclude, plus the tier split.
    include:
      tier === "tmp"
        ? [".tmp-tests/**/*.{test,spec}.ts"]
        : ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      ...excludedTests,
      ...(tier === "tmp" ? [] : ["**/.tmp-tests/**"]),
    ],
    coverage: {
      provider: "v8" as const,
      reporter: [["lcovonly", { projectRoot: repoRoot }]] as [
        "lcovonly",
        { projectRoot: string },
      ][],
      reportsDirectory: ".tmp-tests/coverage",
      // Workspace packages resolve to sibling source directories.
      allowExternal: true,
      exclude: ["**/.tmp-tests/**", ...excludedTests],
    },
  };
}
