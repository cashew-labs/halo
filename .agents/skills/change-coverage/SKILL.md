---
name: change-coverage
description: Review whether new or edited Vitest tests execute changed source lines in a Halo package before opening a pull request. Use after changing code and tests, not as a replacement for behavioral test review.
---

# Review changed test coverage

Run the Halo package from the repository root for each affected Vitest workspace package:

```sh
pnpm coverage:change --package packages/shared --base main
```

The command finds added or edited test files, runs only those tests, asks Vitest to measure the changed source files, and uses diff-cover to report covered and uncovered changed executable lines. It includes committed, staged, unstaged, and untracked files. The first run needs `uv` to fetch the pinned `diff-cover` version. The package's Vitest version needs its matching `@vitest/coverage-v8` dependency.

Read the generated `tmp/change-coverage/latest/report.md` and `vitest.log` before judging the result. Investigate every uncovered line and any source file absent from the coverage data. A missing file is an unknown measurement, not a pass. `no-changed-tests` means this command did not measure the change; add a meaningful test for changed behavior or explain why the existing tests suffice. `no-changed-source` is expected for a test-only edit. A covered line only proves execution; inspect the assertions and failure cases to decide whether the tests check the intended behavior.

For the final pre-PR pass, run tests related to changed source files with `vitest related --run` in the owning package, then run Halo's `pnpm run check-affected`. `vitest related` follows static imports and can miss dynamic imports; run the relevant integration or E2E flow when the change depends on one. Report the targeted coverage result, the broader test result, and any limits to the user.
