import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as errore from "errore";
import { execa } from "execa";

export class ChangeCoverageError extends errore.createTaggedError({
  name: "ChangeCoverageError",
  message: "Change coverage failed: $detail",
}) {}

export type ChangeCoverageOptions = {
  packageDir: string;
  base?: string;
  outputDir?: string;
};

export type ChangeCoverageReport = {
  status:
    | "covered"
    | "uncovered"
    | "failed"
    | "no-changed-tests"
    | "no-changed-source";
  reportPath: string;
  testFiles: string[];
  sourceFiles: string[];
  missingCoverageFiles: string[];
};

type CommandResult = { exitCode: number; output: string };
type DiffCoverStats = {
  total_num_lines: number;
  total_num_violations: number;
  total_percent_covered: number;
  src_stats: Record<string, { violation_lines: number[] }>;
};

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<CommandResult | ChangeCoverageError> {
  const attempt = await execa(command, args, {
    cwd,
    reject: false,
    all: true,
  }).then(
    (result) => ({ result }),
    (cause) => ({
      error: new ChangeCoverageError({ detail: `start ${command}`, cause }),
    }),
  );
  if ("error" in attempt) return attempt.error;
  return {
    exitCode: attempt.result.exitCode ?? 1,
    output: attempt.result.all ?? "",
  };
}

function splitPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

async function changedPaths(
  root: string,
  comparisonBase: string,
): Promise<string[] | ChangeCoverageError> {
  const commands = [
    ["diff", "--name-only", "-z", "--diff-filter=ACMR", comparisonBase],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
  const paths = new Set<string>();
  for (const args of commands) {
    const result = await runCommand("git", args, root);
    if (result instanceof Error) return result;
    if (result.exitCode !== 0) {
      return new ChangeCoverageError({
        detail: `git ${args[0]}: ${result.output.trim()}`,
      });
    }
    for (const path of splitPaths(result.output)) paths.add(path);
  }
  return [...paths].toSorted();
}

function withinPackage(path: string, prefix: string): string | undefined {
  if (!prefix) return path;
  if (!path.startsWith(`${prefix}/`)) return undefined;
  return path.slice(prefix.length + 1);
}

function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function isSourceFile(path: string): boolean {
  return (
    /\.[cm]?[jt]sx?$/.test(path) &&
    !/\.d\.[cm]?ts$/.test(path) &&
    !isTestFile(path)
  );
}

function normalizeLcov(lcov: string, root: string, packageDir: string) {
  const files = new Set<string>();
  const normalized = lcov
    .split("\n")
    .map((line) => {
      if (!line.startsWith("SF:")) return line;
      const source = line.slice(3).trim();
      const absolute = isAbsolute(source)
        ? source
        : resolve(packageDir, source);
      const rootPath = relative(root, absolute).split(sep).join("/");
      files.add(rootPath);
      return `SF:${rootPath}`;
    })
    .join("\n");
  return { normalized, files };
}

function parseDiffCoverStats(
  raw: string,
): DiffCoverStats | ChangeCoverageError {
  const parsed = errore.try({
    // SAFETY: The pinned diff-cover version writes this JSON schema at the local tool boundary.
    try: () => JSON.parse(raw) as DiffCoverStats,
    catch: (cause) =>
      new ChangeCoverageError({ detail: "parse diff-cover JSON", cause }),
  });
  return parsed;
}

async function createDiffFile(
  root: string,
  comparisonBase: string,
  prefix: string,
  sourceFiles: string[],
  outputDir: string,
): Promise<string | ChangeCoverageError> {
  const tracked = await runCommand(
    "git",
    ["diff", comparisonBase, "--", prefix || "."],
    root,
  );
  if (tracked instanceof Error) return tracked;
  if (tracked.exitCode !== 0) {
    return new ChangeCoverageError({
      detail: `generate diff: ${tracked.output.trim()}`,
    });
  }
  const untracked = await runCommand(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    root,
  );
  if (untracked instanceof Error) return untracked;
  if (untracked.exitCode !== 0) {
    return new ChangeCoverageError({
      detail: `find untracked files: ${untracked.output.trim()}`,
    });
  }
  const untrackedPaths = new Set(splitPaths(untracked.output));
  const patches = [tracked.output];
  for (const path of sourceFiles) {
    const rootPath = prefix ? `${prefix}/${path}` : path;
    if (!untrackedPaths.has(rootPath)) continue;
    const patch = await runCommand(
      "git",
      ["diff", "--no-index", "--", "/dev/null", rootPath],
      root,
    );
    if (patch instanceof Error) return patch;
    if (patch.exitCode !== 1) {
      return new ChangeCoverageError({
        detail: `generate untracked diff for ${rootPath}: ${patch.output.trim()}`,
      });
    }
    patches.push(patch.output);
  }
  const diffPath = resolve(outputDir, "change.patch");
  const saved = await saveReport(diffPath, patches.join("\n"));
  return saved ?? diffPath;
}

function markdownList(items: string[]): string {
  return items.length
    ? items.map((item) => `- \`${item}\``).join("\n")
    : "None.";
}

async function saveReport(
  reportPath: string,
  content: string,
): Promise<ChangeCoverageError | undefined> {
  const result = await writeFile(reportPath, content).catch(
    (cause) =>
      new ChangeCoverageError({ detail: `write ${reportPath}`, cause }),
  );
  return result instanceof Error ? result : undefined;
}

export async function runChangeCoverage(
  options: ChangeCoverageOptions,
): Promise<ChangeCoverageReport | ChangeCoverageError> {
  const packageDir = resolve(options.packageDir);
  const base = options.base ?? "main";
  const rootResult = await runCommand(
    "git",
    ["rev-parse", "--show-toplevel"],
    packageDir,
  );
  if (rootResult instanceof Error) return rootResult;
  if (rootResult.exitCode !== 0) {
    return new ChangeCoverageError({
      detail: `find Git root: ${rootResult.output.trim()}`,
    });
  }
  const root = rootResult.output.trim();
  const mergeBase = await runCommand("git", ["merge-base", base, "HEAD"], root);
  if (mergeBase instanceof Error) return mergeBase;
  if (mergeBase.exitCode !== 0) {
    return new ChangeCoverageError({
      detail: `compare with ${base}: ${mergeBase.output.trim()}`,
    });
  }
  const comparisonBase = mergeBase.output.trim();
  const prefix = relative(root, packageDir).split(sep).join("/");
  if (prefix.startsWith("..")) {
    return new ChangeCoverageError({
      detail: "package directory is outside the Git repository",
    });
  }
  const paths = await changedPaths(root, comparisonBase);
  if (paths instanceof Error) return paths;
  const outputDir = resolve(
    options.outputDir ?? resolve(root, "tmp/change-coverage/latest"),
  );
  const outputPrefix = relative(root, outputDir).split(sep).join("/");
  const localPaths = paths
    .filter(
      (path) => path !== outputPrefix && !path.startsWith(`${outputPrefix}/`),
    )
    .map((path) => withinPackage(path, prefix))
    .filter((path): path is string => !!path);
  const testFiles = localPaths.filter(isTestFile);
  const sourceFiles = localPaths.filter(isSourceFile);
  const created = await mkdir(outputDir, { recursive: true }).catch(
    (cause) =>
      new ChangeCoverageError({ detail: `create ${outputDir}`, cause }),
  );
  if (created instanceof Error) return created;
  const reportPath = resolve(outputDir, "report.md");
  const header = `# Changed test coverage\n\nBase: \`${base}\`  \nPackage: \`${prefix || "."}\`\n\n## Changed tests\n\n${markdownList(testFiles)}\n\n## Changed source files\n\n${markdownList(sourceFiles)}\n`;

  if (testFiles.length === 0) {
    const saved = await saveReport(
      reportPath,
      `${header}\n## Result\n\nNo changed test files were found. This run provides no test coverage signal.\n`,
    );
    if (saved) return saved;
    return {
      status: "no-changed-tests",
      reportPath,
      testFiles,
      sourceFiles,
      missingCoverageFiles: [],
    };
  }

  const coverageDir = resolve(outputDir, "coverage");
  for (const path of [coverageDir, resolve(outputDir, "diff-cover.json")]) {
    const removed = await rm(path, { recursive: true, force: true }).catch(
      (cause) =>
        new ChangeCoverageError({
          detail: `clear prior result ${path}`,
          cause,
        }),
    );
    if (removed instanceof Error) return removed;
  }
  const vitestArgs = ["exec", "vitest", "run", ...testFiles];
  if (sourceFiles.length > 0) {
    vitestArgs.push(
      "--coverage.enabled",
      "--coverage.reporter=lcov",
      `--coverage.reportsDirectory=${coverageDir}`,
    );
    for (const path of sourceFiles)
      vitestArgs.push(`--coverage.include=${path}`);
  }
  const vitest = await runCommand("pnpm", vitestArgs, packageDir);
  if (vitest instanceof Error) return vitest;
  const vitestLog = resolve(outputDir, "vitest.log");
  const savedLog = await saveReport(vitestLog, vitest.output);
  if (savedLog) return savedLog;

  if (sourceFiles.length === 0) {
    const status = vitest.exitCode === 0 ? "no-changed-source" : "failed";
    const saved = await saveReport(
      reportPath,
      `${header}\n## Result\n\nVitest exit code: ${vitest.exitCode}. No changed source files were found, so there is no changed-line coverage to calculate. See \`vitest.log\`.\n`,
    );
    if (saved) return saved;
    return {
      status,
      reportPath,
      testFiles,
      sourceFiles,
      missingCoverageFiles: [],
    };
  }

  const lcovPath = resolve(coverageDir, "lcov.info");
  const lcov = await readFile(lcovPath, "utf8").catch(() => undefined);
  const rootSourceFiles = sourceFiles.map((path) =>
    prefix ? `${prefix}/${path}` : path,
  );
  const normalizedLcov =
    lcov === undefined ? undefined : normalizeLcov(lcov, root, packageDir);
  const measured = normalizedLcov?.files ?? new Set<string>();
  const missingCoverageFiles = rootSourceFiles.filter(
    (path) => !measured.has(path),
  );
  let diffCoverOutput = "Coverage report was not generated.";
  let diffCoverExitCode = 1;
  let stats: DiffCoverStats | undefined;
  if (normalizedLcov !== undefined) {
    const normalizedLcovPath = resolve(outputDir, "lcov-root.info");
    const savedLcov = await saveReport(
      normalizedLcovPath,
      normalizedLcov.normalized,
    );
    if (savedLcov) return savedLcov;
    const diffPath = await createDiffFile(
      root,
      comparisonBase,
      prefix,
      sourceFiles,
      outputDir,
    );
    if (diffPath instanceof Error) return diffPath;
    const diffCoverArgs = [
      "--from",
      "diff-cover==10.6.0",
      "diff-cover",
      normalizedLcovPath,
      `--diff-file=${diffPath}`,
      "--show-uncovered",
      "--format",
      `json:${resolve(outputDir, "diff-cover.json")}`,
    ];
    const diffCover = await runCommand("uvx", diffCoverArgs, root);
    if (diffCover instanceof Error) return diffCover;
    diffCoverOutput = diffCover.output;
    diffCoverExitCode = diffCover.exitCode;
    const savedDiffLog = await saveReport(
      resolve(outputDir, "diff-cover.log"),
      diffCoverOutput,
    );
    if (savedDiffLog) return savedDiffLog;
    const jsonPath = resolve(outputDir, "diff-cover.json");
    const json = await readFile(jsonPath, "utf8").catch(() => undefined);
    if (json !== undefined) {
      const parsed = parseDiffCoverStats(json);
      if (parsed instanceof Error) return parsed;
      stats = parsed;
    }
  }
  const status =
    vitest.exitCode !== 0 ||
    diffCoverExitCode !== 0 ||
    missingCoverageFiles.length > 0 ||
    stats === undefined ||
    stats.total_num_lines === 0
      ? "failed"
      : stats.total_num_violations > 0
        ? "uncovered"
        : "covered";
  const uncoveredLines =
    stats === undefined
      ? []
      : Object.entries(stats.src_stats)
          .filter(([, file]) => file.violation_lines.length > 0)
          .map(([path, file]) => `${path}:${file.violation_lines.join(",")}`);
  const measurement =
    stats === undefined
      ? "No valid diff-cover result was produced."
      : `${stats.total_num_lines - stats.total_num_violations}/${stats.total_num_lines} executable changed lines covered (${stats.total_percent_covered}%).`;
  const content = `${header}\n## Result\n\nStatus: **${status}**  \nVitest exit code: ${vitest.exitCode}  \ndiff-cover exit code: ${diffCoverExitCode}\n\n${measurement}\n\n## Uncovered changed lines\n\n${markdownList(uncoveredLines)}\n\n## Changed source files absent from coverage data\n\n${markdownList(missingCoverageFiles)}\n\nAn absent file is an unknown measurement, not a passing result.\n\nInspect \`vitest.log\`, \`diff-cover.log\`, and \`diff-cover.json\` in this directory for the full run. Coverage shows execution, not whether assertions check the intended behavior.\n`;
  const saved = await saveReport(reportPath, content);
  if (saved) return saved;
  return { status, reportPath, testFiles, sourceFiles, missingCoverageFiles };
}
