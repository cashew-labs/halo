/* oxlint-disable anti-slop/no-runtime-typeof -- This dependency-free parser validates raw PR JSON at its I/O boundary. */

export function validateTestReport({ body, headSha }) {
  const markers = [...(body ?? "").matchAll(/<!--\s*halo-tests:/g)];
  if (markers.length !== 1) {
    return new Error(
      "The PR description must contain exactly one <!-- halo-tests:v1 ... --> report. Add or fix it using the format in AGENTS.md.",
    );
  }

  const match = body
    .slice(markers[0].index)
    .match(/^<!--\s*halo-tests:v1\s+([\s\S]*?)-->/);
  if (!match) {
    return new Error(
      "The test report must use halo-tests:v1 and end with -->. Fix the marker in the PR description.",
    );
  }

  const report = (() => {
    try {
      return JSON.parse(match[1]);
    } catch (cause) {
      return new Error(
        "The test report is not valid JSON. Fix the JSON inside the hidden marker in the PR description.",
        { cause },
      );
    }
  })();
  if (report instanceof Error) return report;
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return new Error(
      "The test report must be an object with commit, required, and passed fields. Use the format in AGENTS.md.",
    );
  }
  if (
    typeof report.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(report.commit)
  ) {
    return new Error(
      "The test report's commit must be a full 40-character SHA. Verify the PR head's code and report its full SHA.",
    );
  }
  if (report.commit !== headSha) {
    return new Error(
      `The test report is outdated. Verify the code in ${headSha}, then update commit and passed in the PR description.`,
    );
  }

  for (const field of ["required", "passed"]) {
    if (
      !Array.isArray(report[field]) ||
      !report[field].every(
        (command) =>
          typeof command === "string" &&
          command.length > 0 &&
          command.trim() === command,
      ) ||
      new Set(report[field]).size !== report[field].length
    ) {
      return new Error(
        `The test report's ${field} must be an array of unique, nonempty command strings without surrounding whitespace. Fix that field in the PR description.`,
      );
    }
  }

  if (report.passed.some((command) => !report.required.includes(command))) {
    return new Error(
      "The passed list contains commands not declared in required. Use exactly the same command identifiers in both lists.",
    );
  }
  const missing = report.required.filter(
    (command) => !report.passed.includes(command),
  );
  if (missing.length > 0) {
    return new Error(
      `Required tests have not been reported as passing:\n${missing.join("\n")}\nRun them locally and update passed only after they succeed.`,
    );
  }

  return report;
}
