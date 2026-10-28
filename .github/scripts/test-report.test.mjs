/* oxlint-disable unicorn/no-null -- Exercise JSON null values from PR descriptions and malformed reports. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateTestReport } from "./test-report.mjs";

const headSha = "a1".repeat(20);
const workspace = "pnpm --filter @get-halo/workspace-server test:e2e";
const desktop = "pnpm --filter @get-halo/desktop test:e2e";

function marker(report) {
  return `<!-- halo-tests:v1\n${JSON.stringify(report)}\n-->`;
}

const complete = {
  commit: headSha,
  required: [workspace, desktop],
  passed: [desktop, workspace],
};

test("accepts a complete self-report surrounded by PR prose regardless of result order", () => {
  const body = `Fix reconnect behavior.\n\n${marker(complete)}\n\nReview notes.`;
  assert.deepEqual(validateTestReport({ body, headSha }), complete);
});

test("accepts an explicit declaration that no tests are required", () => {
  const report = { commit: headSha, required: [], passed: [] };
  assert.deepEqual(
    validateTestReport({ body: marker(report), headSha }),
    report,
  );
});

test("blocks an incomplete report and identifies only the missing command", () => {
  const result = validateTestReport({
    body: marker({ ...complete, passed: [workspace] }),
    headSha,
  });
  assert(result instanceof Error);
  assert(result.message.includes(desktop));
  assert(!result.message.includes(workspace));
});

test("a passing report stops passing when the PR head changes", () => {
  const result = validateTestReport({
    body: marker(complete),
    headSha: "b2".repeat(20),
  });
  assert(result instanceof Error);
  assert.match(result.message, /outdated/);
});

test("adding a required test invalidates the report until that exact command is reported", () => {
  const required = [workspace, `${desktop} --workers=1`];
  const result = validateTestReport({
    body: marker({ ...complete, required, passed: [workspace] }),
    headSha,
  });
  assert(result instanceof Error);
  assert(result.message.includes(`${desktop} --workers=1`));
  assert.deepEqual(
    validateTestReport({
      body: marker({ ...complete, required, passed: required }),
      headSha,
    }).passed,
    required,
  );
});

test("rejects missing, duplicate, unsupported, unterminated, and malformed reports", () => {
  for (const body of [
    undefined,
    null,
    "",
    "All tests passed!",
    `${marker(complete)}\n${marker(complete)}`,
    `${marker(complete)}\n<!-- halo-tests:v1`,
    marker(complete).replace("v1", "v2"),
    marker(complete).replace("v1", "v10"),
    marker(complete).replace("-->", ""),
    "<!-- halo-tests:v1\n{ invalid JSON }\n-->",
  ]) {
    assert(
      validateTestReport({ body, headSha }) instanceof Error,
      `Should reject ${JSON.stringify(body)}`,
    );
  }
});

test("rejects invalid schema and contradictory results instead of treating them as no tests", () => {
  for (const report of [
    null,
    [],
    "passed",
    {},
    { ...complete, commit: headSha.slice(0, 7) },
    { ...complete, commit: "main" },
    { ...complete, commit: "z".repeat(40) },
    { ...complete, required: null },
    { ...complete, required: workspace },
    { ...complete, passed: undefined },
    { ...complete, passed: [true] },
    { ...complete, required: [""] },
    { ...complete, required: ["   "] },
    { ...complete, passed: [` ${workspace}`, desktop] },
    { ...complete, required: [workspace, workspace] },
    { ...complete, passed: [workspace, desktop, desktop] },
    { ...complete, passed: [...complete.passed, "pnpm unrelated-test"] },
    { ...complete, required: [], passed: [workspace] },
  ]) {
    assert(
      validateTestReport({ body: marker(report), headSha }) instanceof Error,
      `Should reject ${JSON.stringify(report)}`,
    );
  }
});
