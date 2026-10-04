import { resolve } from "node:path";
import { runChangeCoverage } from "./index.js";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
const invocationDir = process.env.INIT_CWD ?? process.cwd();
const packagePath = valueAfter(args, "--package");
const outputPath = valueAfter(args, "--output");
if (!packagePath) {
  console.error(
    "Usage: pnpm coverage:change --package <workspace-package> [--base <ref>] [--output <dir>]",
  );
  process.exitCode = 2;
} else {
  const report = await runChangeCoverage({
    packageDir: resolve(invocationDir, packagePath),
    base: valueAfter(args, "--base"),
    outputDir:
      outputPath === undefined ? undefined : resolve(invocationDir, outputPath),
  });
  if (report instanceof Error) {
    console.error(report.message);
    process.exitCode = 1;
  } else {
    console.log(`Changed tests: ${report.testFiles.length}`);
    console.log(`Changed source files: ${report.sourceFiles.length}`);
    console.log(`Status: ${report.status}`);
    console.log(`Report: ${report.reportPath}`);
    process.exitCode =
      report.status === "covered" || report.status === "no-changed-source"
        ? 0
        : 1;
  }
}
