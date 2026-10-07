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
 * package's gitignored `.tmp-tests/` files. When the review tool sets
 * `REVIEW_TEST_FILES` (newline-separated repo-relative paths), only the listed
 * files in this package run; a package with none runs nothing. `--coverage`
 * writes lcov with repo-relative paths to
 * `<package>/.tmp-tests/coverage/lcov.info`.
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
      listedTestFiles() ??
      (tier === "tmp"
        ? [".tmp-tests/**/*.{test,spec}.ts"]
        : ["**/*.{test,spec}.?(c|m)[jt]s?(x)"]),
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

/** The `REVIEW_TEST_FILES` entries inside this package, relative to it. Vitest runs from the package directory. */
function listedTestFiles(): string[] | undefined {
  const listed = process.env.REVIEW_TEST_FILES;
  if (listed === undefined) return undefined;
  const files = listed
    .split("\n")
    .filter(Boolean)
    .map((file) => path.relative(process.cwd(), path.join(repoRoot, file)))
    .filter((file) => !file.startsWith(".."))
    // `include` takes glob patterns, so escape characters that globs treat specially.
    .map((file) => file.replace(/[\\[\]{}()*?!+@]/g, "\\$&"));
  // A pattern that matches nothing, because an empty include falls back to Vitest's default.
  return files.length > 0 ? files : ["__no-listed-test-files__"];
}
