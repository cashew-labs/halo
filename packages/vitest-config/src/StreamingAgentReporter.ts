import type { SerializedError } from "vitest";
import type {
  Reporter,
  TestCase,
  TestModule,
  TestRunEndReason,
  TestSuite,
  Vitest,
} from "vitest/node";

export default class StreamingAgentReporter implements Reporter {
  // Tracks the start of the current run for the final elapsed time.
  private startedAt = 0;

  // Provides Vitest's configured output streams and error formatting.
  private vitest!: Vitest;

  onInit(vitest: Vitest) {
    this.vitest = vitest;
    this.vitest.logger.printBanner();
  }

  onTestRunStart() {
    this.startedAt = performance.now();
  }

  onTestCaseResult(testCase: TestCase) {
    const result = testCase.result();
    const label = resultLabel(result.state);
    const message = `${label} ${testCase.module.relativeModuleId} > ${testCase.fullName}${formatDuration(testCase.diagnostic()?.duration)}`;

    if (result.state !== "failed") {
      this.vitest.logger.log(message);
      return;
    }

    this.vitest.logger.error(message);
    for (const error of result.errors) {
      this.vitest.logger.printError(error, { project: testCase.project });
    }
  }

  onTestSuiteResult(testSuite: TestSuite) {
    this.printCollectionErrors(
      `${testSuite.module.relativeModuleId} > ${testSuite.fullName}`,
      testSuite.errors(),
      testSuite.project,
    );
  }

  onTestModuleEnd(testModule: TestModule) {
    this.printCollectionErrors(
      testModule.relativeModuleId,
      testModule.errors(),
      testModule.project,
    );
  }

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason,
  ) {
    if (unhandledErrors.length > 0) {
      this.vitest.logger.printUnhandledErrors(unhandledErrors);
    }

    const tests = testModules.flatMap((testModule) =>
      Array.from(testModule.children.allTests()),
    );
    const passed = tests.filter(
      (test) => test.result().state === "passed",
    ).length;
    const failed = tests.filter(
      (test) => test.result().state === "failed",
    ).length;
    const skipped = tests.filter(
      (test) => test.result().state === "skipped",
    ).length;
    const counts = [
      failed > 0 ? `${failed} failed` : undefined,
      `${passed} passed`,
      skipped > 0 ? `${skipped} skipped` : undefined,
    ].filter((count) => count !== undefined);
    const duration = formatDuration(performance.now() - this.startedAt);

    this.vitest.logger.log(
      `${runStatus(reason)} ${counts.join(", ")} in ${testModules.length} ${pluralize("file", testModules.length)}${duration}`,
    );
  }

  private printCollectionErrors(
    name: string,
    errors: ReadonlyArray<SerializedError>,
    project: TestModule["project"],
  ) {
    if (errors.length === 0) return;

    this.vitest.logger.error(`FAIL ${name}`);
    for (const error of errors) {
      this.vitest.logger.printError(error, { project });
    }
  }
}

function resultLabel(state: "passed" | "failed" | "skipped" | "pending") {
  if (state === "passed") return "PASS";
  if (state === "failed") return "FAIL";
  return "SKIP";
}

function runStatus(reason: TestRunEndReason) {
  if (reason === "interrupted") return "INTERRUPTED";
  if (reason === "failed") return "FAIL";
  return "PASS";
}

function formatDuration(duration: number | undefined) {
  if (duration === undefined) return "";
  if (duration < 1_000) return ` (${Math.round(duration)}ms)`;
  return ` (${(duration / 1_000).toFixed(2)}s)`;
}

function pluralize(word: string, count: number) {
  return count === 1 ? word : `${word}s`;
}
