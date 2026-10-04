# Changed test coverage

`@get-halo/change-coverage` is Halo's local pre-PR coverage check. It runs only added or edited Vitest test files in one workspace package, instruments changed source files, and passes a package-scoped patch plus Vitest's LCOV output to diff-cover.

From the repository root:

```sh
pnpm coverage:change --package packages/shared --base main
```

Use `--output <directory>` to keep a particular run. By default, reports go to `tmp/change-coverage/latest/`. The report, Vitest log, diff-cover log, JSON data, and exact patch remain there for agent inspection. The command exits with an error if tests fail, changed lines are uncovered, no changed tests exist, or a changed source file is absent from LCOV.

The command requires `pnpm`, `uv`, and a matching `@vitest/coverage-v8` dependency in the tested workspace package. It uses `uvx` to run pinned `diff-cover==10.6.0`; no prior coverage report is needed. Halo's root and workspace-server packages include the coverage provider for their Vitest versions.

This is a fast signal from the tests changed in the current diff. It does not establish whether those tests make useful assertions or whether unchanged tests still pass. Before opening a PR, use `vitest related --run` for the changed source files and `pnpm run check-affected` for Halo's normal checks.
