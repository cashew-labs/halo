# Test tiers, changed-line coverage, and the review loop

Status: Halo PR 1 (test tiers) implemented; the review tool is in progress in `cashew-labs/code-review-agent`.

## Goal

1. Split Halo's tests into two tiers:
   - **Temp tests** are the default. They run while a PR is developed and reviewed, and they are never merged into `main` or run by CI again.
   - **Durable tests** are opt-in. This is a small set that is committed and runs repeatedly in CI.
2. Measure changed-line coverage from the tests the change added or edited: changed durable tests plus every temp test. Every changed executable line must be covered or exempted with a reason the reviewer accepts.
3. Build a review tool for coding agents. A Pi-based reviewer reviews the logic of the source changes and the tests, checks coverage, and returns findings. The coding agent and the reviewer loop until the reviewer approves. The loop runs only locally.
4. Show every test that ran, including temp tests, and the coverage report in Diffmap and Whiteboard. They are collapsed by default.
5. In a later stack, prune Halo's durable suite to a small CI set.

## Where the work lives

The review tool is personal coding-agent tooling, not part of the Halo product. It lives in a **separate repository**, `cashew-labs/code-review-agent`, and works in any repository that has a config file. Halo keeps only the work that changes how Halo's own tests run.

| Separate repository (the review tool) | Halo |
|---|---|
| The Pi reviewer, its prompt, the `ReviewVerdict` type, and the loop state | `.tmp-tests/` folders and the gitignore rule |
| The changed-line coverage report (`git diff` + merged lcov), and running each test runner with coverage | `@vitest/coverage-v8` for each Vitest version |
| `tmp-tests publish` / `fetch` (the `refs/tmp-tests/*` side ref) | The testing-conventions update |
| The `pre-push` gate and its agent detection | `.review.json`, the tool's config for Halo |
| `review install` (writes the Git hook) and `review doctor` | The `AGENTS.md` section on the push gate |
| The setup prompts: `review connect` (per agent) and `review init` (per repository) | Electron V8 coverage |
| The skill that tells agents how to use the tool | The durable-suite pruning stack |

The command is `review`.

## Current state of Halo (origin/main 1e1c3a9b)

- There is no coverage tooling and no `vitest.config.*` file. `.gitignore` already ignores `coverage` and `.vitest/`.
- `turbo.json` defines `test:unit` and `test:e2e` with no inputs. `pnpm check` runs `test:unit --affected`.
- CI runs only durable unit tests on every PR (`.github/workflows/check.yml`). E2Es run only on release PRs (`.github/workflows/release.yml`).
- Test cases by suite:

  | Suite | Cases |
  |---|---|
  | Electron E2E (`apps/electron/e2e/*.e2e.test.ts`) | ≈112 (`basic` 60, `sessionView` 33) |
  | Workspace-server E2E (`packages/workspace-server/test/workspace.test.ts`) | ≈78 (3,875 lines) |
  | Control plane (`apps/control-plane/test/ControlPlane.test.ts`) | ≈20 |
  | Unit tests | ≈90 |

- These suites are misclassified:
  - `client` and `logger` run their unit tests as `test:e2e`.
  - `halo-cli` has no `test:unit`, so its tests never run.

## Key question: coverage when temp tests are not in Git

Changed-line coverage needs two inputs, and neither one requires the tests to be in Git:

- **Changed lines** come from `git diff <merge-base>`. They are lines of source code, and source code is committed.
- **Covered lines** come from the coverage tool (V8). It records which source lines ran, whichever test file ran them. A gitignored test file runs and contributes coverage like any other file.

So temp tests only have to be **on disk and included by the runner** during the coverage run. The remaining problems are visibility, reproducibility, and stale reports:

| Problem | Solution |
|---|---|
| Reviewers and tools cannot see gitignored files | Snapshot them to a side ref (see below) |
| Tests disappear with the worktree, so nobody can reproduce them | The same side ref |
| The report may describe an older head | The report records `baseSha`, `headSha`, and a hash of the working tree. The reviewer rejects a stale report. |
| Coverage must drop out of the report after merge | Run the changed durable tests and the temp tests separately. The report marks lines that only temp tests cover. |

### Side ref: `refs/tmp-tests/<branch>`

`review tmp-tests publish` builds a commit with a temporary index (`GIT_INDEX_FILE`). The branch, index, and working tree stay unchanged.

- **Parents:** the PR head and the previous side commit, if one exists. Chaining the side commits keeps every round's temp tests reachable.
- **Tree:** the head tree, plus:
  - `**/.tmp-tests/**`
  - the coverage report under `.tmp-tests/report/` (logs excluded)
  - `.tmp-tests/review/round-<n>/verdict.json` and `replies.json`, the review record for this commit

The command pushes the commit to `refs/tmp-tests/<branch>`.

- The ref is outside `refs/heads/`, so GitHub does not list it as a branch, and it is never merged.
- **The ref is never deleted.** No workflow deletes refs today, and Halo's automatic deletion of PR branches is off. The plan adds no cleanup.

This has the following properties:

- `git diff head tmp-tests/<branch>` contains exactly the temp tests, the coverage report, and the review record. It diffs the two trees, because the chained ref also reaches earlier side commits.
- Whiteboard can pin the side commit by SHA. Shares fetch their pinned SHAs from GitHub when they open, so the permanent ref keeps old shares working after the PR closes. GitHub keeps normal PR commits reachable through `refs/pull/<n>/head`, but the side commit has no such ref.
- A Diffmap `source-diff` embeds the patch text, so it does not depend on the ref.
- Readers fetch the ref with `review tmp-tests fetch`, which runs `git fetch origin 'refs/tmp-tests/*:refs/tmp-tests/*'`.

Alternatives considered:
- **Attach tests as a CI artifact.** Tools cannot pin an artifact, and artifacts expire.
- **Commit the tests in the PR and drop them in a final commit.** The squashed diff would hide the tests from reviewers.
- **Upload to a gist.** It has no Git relation to the head.
- **A branch under `refs/heads/` that a workflow deletes when the PR closes.** Deleting it breaks Whiteboard shares pinned to the side commit.

## Design

### 1. Test tiers (Halo)

**Temp tier (the default).** Files are `<package>/.tmp-tests/**/*.test.ts` (or `*.spec.ts`).
- `**/.tmp-tests/` is gitignored, except in the side-ref commit.
- Temp tests use the package's existing fixtures and the same fixture API as durable tests.

**Durable tier.** This tier uses the existing locations from `conventions/references/testing.md`.
- There is no fixed budget. The coding agent and the reviewer choose the tier by judgment, and most tests should be temp tests.
- A new durable test needs a rationale that the reviewer accepts, for example "guards invariant X across future changes".

**Selection.** The review tool chooses the files and runs them itself, so Halo needs no selection code:
- For each tier it gives every selected test file to the first `.review.json` `tests` entry whose `dir` and `match` fit it, and runs that entry's runner with exactly those files.
- Vitest runs once per package (the nearest folder with a `package.json`), with the package's own `vitest` binary, so `workspace-server`'s Vitest 4 and the root's Vitest 5 each run their own packages. The tool adds `--coverage.enabled`, the lcov reporter, and `--coverage.allowExternal`; Halo's Vitest setup is unchanged.
- Temp tests sit where the runner already looks, so Vitest's default `include` finds `src/.tmp-tests/*.test.ts` without a config. Local `pnpm test` runs pick them up too; CI never has them.
- `pnpm check` stays durable-only.

**Promotion** to the durable tier is a file move. The reviewer must accept it.

### 2. Changed-line coverage (review tool)

**Collection** is the review tool's job. Halo installs `@vitest/coverage-v8` at each Vitest version: 5.0.1 at the root and 4.1.11 in `workspace-server`. `allowExternal` keeps coverage of sibling workspace packages, and Vitest 5 reports only files that tests loaded, which is what `all: false` did in older versions. Coverage output goes to the worktree's Git directory, so it is never committed or published.

**Which tests run.** Coverage starts from the tests the change added or edited, not the whole suite:
- **Durable run:** the durable test files that the change added or modified, compared with the merge-base, including uncommitted ones. A test file is any file named `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`, or `*_test.go`.
- **Temp run:** every temp test file.

An existing test that the change relies on counts only once it is edited. The coding agent should add a temp test for the new behavior rather than touch an existing test with a no-op edit. This works the same way for Playwright, which also accepts a list of test files. A tier with no files is skipped. A round runs a handful of tests, so no suite is run in full.

**Report.** `review coverage` builds the report from Git and lcov, with nothing specific to Halo:
1. Parse `git diff -U0 <merge-base>`, plus untracked files, for added and changed lines in source files (see "Default exclusions").
2. Run the changed durable test files through their `tests` entries and merge the coverage: a line counts as covered if any runner reports it ran more than 0 times.
3. Run the temp test files the same way.
4. Combine the two runs. Each changed line gets one of these states:
   - covered by durable tests (in the durable run);
   - covered by temp tests only (in the temp run but not the durable run), so its coverage disappears after merge;
   - uncovered (in neither run);
   - exempt.
5. Write `.tmp-tests/report/report.json`, apart from the repository's lcov glob so the tool's output is never merged back in:
   - `baseSha`, `headSha`, `treeHash`;
   - per file: `changed`, `coveredDurable`, `coveredTmpOnly`, `uncovered`, `exempt`;
   - the durable and temp test file lists, and each run's result and log path.

**Default exclusions.** Only code files count, judged by extension (`.ts`, `.tsx`, `.js`, `.py`, `.go`, and similar), so Markdown specs and JSON never count. Test files and tool configuration never count: `**/*.test.*`, `**/*.spec.*`, `**/*.config.*`, `**/.tmp-tests/**`, `**/test/**`, `**/tests/**`, `**/e2e/**`, and `**/__tests__/**`. Build output is gitignored, so it never appears in the diff. A repository with committed generated code adds those paths through the optional `exclude` field.

**Exemptions.** A `// coverage-exempt: <reason>` comment exempts a line or block. Every exemption appears in the report, and the reviewer judges the reason.

**Gate.** All changed executable lines are covered or exempt, and every run that had test files passes.

**Temp tests stand alone.** A temp test cannot depend on code in a durable test file, because the two tiers run separately. Shared setup belongs in the package's fixtures or test config, as Halo's conventions already require.

### 3. Reviewer (review tool)

**Purpose.** A Pi harness (`@earendil-works/pi-coding-agent`) for a read-only reviewer session. It reasons and uses tools like a normal coding agent, but it never changes code or tests; only the coding agent does.

**Model.** Claude Opus 5.5 (`claude-opus-5-5`) by default, with high reasoning effort. A flag or environment variable can override it. If Pi's model catalog does not list `claude-opus-5-5`, the tool defines the model metadata itself, as Halo does for `togetherModel` in `packages/config/src/inference.ts`.

**Credentials.** The reviewer uses your Claude Pro/Max login through Pi's Anthropic OAuth flow ("Anthropic (Claude Pro/Max)"), stored in Pi's `auth.json`. `review login` runs that flow once. `ANTHROPIC_API_KEY`, if set, takes priority.

**Tools:**
- Pi's read-only tool set (`createReadOnlyTools`): `read`, `grep`, `find` (glob), and `ls`.
- `git diff`.
- The configured test command and `review coverage`.
- No write or edit tools, and no general shell. The tool runs only the commands above, through an allowlist. Their only output is under `.tmp-tests/coverage/` and the loop state directory.

Pi's `grep` and `find` respect `.gitignore`, so they do not list `.tmp-tests/` files. The tool passes the temp test paths from `report.json` in the prompt, and `read` opens them directly.

**Review scope.** The reviewer reviews two things in each round:
1. **Source changes.** It reads every changed source file and checks the logic: incorrect behavior, unhandled errors and edge cases, broken contracts with callers, races, and security problems. Each problem is a finding, whatever the test results are. Passing tests and full coverage do not prove the logic is correct.
2. **Tests.** The prompt includes this text:

   > Read the tests that cover the changed code. Check that they verify the behavior the change is meant to produce, not just that the code runs. A test that doesn't is a finding, like any other bug.

   This overrides any code-review instruction against commenting on test coverage. Coverage shows which changed lines run; the reviewer judges whether the tests that run them check the right behavior.

**Prompt inputs:**
- the repository's instruction files: `AGENTS.md` and `CLAUDE.md` if present, or the files listed in the optional `instructions` field. Halo's `AGENTS.md` links to the code-review and conventions skills, and the reviewer follows those links with its read tools;
- the diff;
- `report.json`, including the temp test paths;
- the previous round's verdict and the coder's replies.

**Output.** The reviewer ends each round by calling a `submit_verdict` tool whose input is the verdict type. The tool rejects an incomplete verdict.

```ts
type ReviewVerdict = {
  round: number;
  status: "approve" | "changes_requested" | "escalate";
  headSha: string;
  // `id` stays the same when a later round raises the same issue, even if the line moves.
  findings: { id: string; kind: "source" | "test"; file: string; line: number; severity: "P0" | "P1"; body: string }[];
  testRequests: { target: string; tier: "tmp" | "durable"; rationale: string }[];
  tierChanges: { file: string; to: "tmp" | "durable"; rationale: string }[];
  coverage: { changed: number; covered: number; exempt: number };
};
```

**Approval rules.** The reviewer approves only when all of these hold:
- every test run that had files passes;
- changed-line coverage is 100% (covered or exempt with a reason the reviewer accepts);
- no open P0 or P1 findings remain, in the source changes or in the tests.

**State.** All loop state is local and never committed:
- `.tmp-tests/review/<branch>/round-<n>/verdict.json`: the verdict for round *n*. It sits under `.tmp-tests/`, so `review tmp-tests publish` includes it in the side ref.
- `.tmp-tests/review/<branch>/round-<n>/replies.json`: the coder's replies for round *n*, as `{ findingId: string; reply: string }[]`. `review reply` writes this file.
- `.git/code-review-agent/sessions/<branch>/`: the persisted reviewer session, so later rounds remember earlier rulings and do not raise them again. It is inside the Git directory, so it is never published.
- `.git/code-review-agent/approved`: the head SHAs that received `approve`. The push gate reads this file.

### 4. Trigger: the push gate

The review runs when an agent tries to get code into a PR, not when it finishes a task. The coding agent can stop and show small changes without any review. Commits are not gated either, because agents commit work in progress often.

**Mechanism.** A Git `pre-push` hook runs `review gate`. Every push goes through it, including `git push`, the push inside `gh pr create`, and `gh stack submit`. One hook works for every coding agent, so there are no per-agent hooks, plugins, or sync tools.

**The gate only checks; it does not review.** A full review can take several minutes, longer than many agents' shell-command timeouts. So:
1. The agent finishes the feature and runs `git push`.
2. `review gate` passes at once if `approved` contains the commit being pushed.
3. Otherwise the push fails with: "No approved review for `<sha>`. Run `review`, address the findings, then push again."
4. The agent runs `review` as an ordinary long-running command. Each run is one round. It fixes each finding, or answers it with `review reply <findingId> "won't fix: <reason>"`, and runs `review` again.
5. On `approve`, `review` records the SHA and runs `review tmp-tests publish`. The agent pushes again, and the gate passes.
6. A new commit after approval has a new SHA, so the gate requires a new review. Unchanged code is never reviewed twice.

**Only agent pushes are gated.** A push from your own terminal passes straight through. The main switch is `REVIEW_GATE=1`, which `review connect` has each agent add to its own configuration (see "Setup"). Built-in agent markers are a fallback, so an agent that has not been set up yet is still gated. The gate enforces review when any of these is set:

| Agent | Marker | Verified |
|---|---|---|
| Claude Code | `CLAUDECODE` | In this session's shell |
| Cursor (`cursor-agent`) | `CURSOR_AGENT` | In the installed program |
| Codex | `CODEX_THREAD_ID` (`CODEX_SANDBOX` is set only inside its sandbox) | In the installed program |
| Amp | `AGENT=amp` (it also sets `CLAUDECODE`, so check `AGENT` first) | In the installed program |
| Gemini CLI | `GEMINI_CLI` | From its source, not installed here |
| Copilot CLI | `COPILOT_CLI` | From detection libraries, not installed here |
| Generic | `AGENT`, `AI_AGENT` | Proposed standard ([agents.md #136](https://github.com/agentsmd/agents.md/issues/136)) |
| Any agent (main switch) | `REVIEW_GATE=1` | Set by `review connect` in that agent's own configuration |

- OpenCode (`OPENCODE_CLIENT`) and Pi are unconfirmed. Implementation checks each by having it run `env`; without a marker, they rely on `REVIEW_GATE=1`.
- `REVIEW_GATE=0` turns the gate off, for example to push by hand from inside an agent's terminal.

**Termination:**
- **Round cap: 5.** If round 5 does not approve, the verdict is `escalate`, and `review` refuses to start a sixth round for that SHA.
- The verdict is also `escalate` early if the same finding `id` is disputed twice.
- On `escalate`, the push stays blocked and the agent reports to you.

**Bypass.** An agent could run `git push --no-verify` or unset the marker. The `AGENTS.md` section forbids that. This is a workflow guard for your own agents, not a security boundary.

**Agent instructions.** A short skill, also copied into the repository's `AGENTS.md`, explains the gate, the `review` and `review reply` commands, and the tier rules. The gate's error message names the command to run, so an agent that missed the instructions still learns it at push time.

### 5. Setup

Setup has two scopes. Both are prompts that you paste into a coding agent, because the agent knows (or can look up) where its own settings live and how the repository runs its tests. Fixed installer code would need per-agent and per-repository knowledge. No existing package sets environment variables per agent; rulesync, agent-config, and `npx skills add` cover hooks, rules, MCP, and skills only.

| Command | Scope | When | Result |
|---|---|---|---|
| `review connect` | Per agent, on your machine | Once per coding agent | The CLI is installed, `REVIEW_GATE=1` is in that agent's configuration, and you are logged in |
| `review init` | Per repository, committed | Once per repository | Test tiers and coverage are set up, `.review.json` exists, and the Git hook is installed |

**`review connect`** prints this prompt:

> Set up the code-review-agent push gate for yourself.
> 1. Install the CLI: `npm i -g @cashew-labs/code-review-agent`.
> 2. Add the environment variable `REVIEW_GATE=1` to **your own agent configuration**, so it is set in every shell command you run. Do not put it in a shell profile such as `~/.zshrc` or `~/.bashrc`; it must not apply to my normal terminal. If you cannot set environment variables for your shell commands, stop and tell me.
> 3. In this repository, run `review install`.
> 4. Ask me to run `review login` myself, because it opens a browser.
> 5. Tell me to restart you. After the restart, run `review doctor` and report the result.

**`review init`** prints a prompt that has the agent:
1. Write `.review.json` with one `tests` entry per kind of test file (Vitest, Playwright, or a command such as `node --test {files}`), and install the coverage provider each runner needs.
2. Add `**/.tmp-tests/` to `.gitignore` and the push-gate section to `AGENTS.md`.
3. Run `review install`.
4. Add a throwaway temp test for each entry, run `review coverage --check`, and fix whatever it reports, until it passes.

The result is an ordinary PR to that repository. Halo PR 1 is Halo's `review init` work, done by hand, and becomes the worked example the prompt points to.

**Checks:**
- `review doctor` checks this agent's setup: `REVIEW_GATE=1` is visible in its shell, the hook is installed, `.review.json` exists, and the Anthropic login works.
- `review coverage --check` checks the repository's setup: every selected test file has a `tests` entry, each run that had files passes and records executed source lines, and the lcov paths match repository paths.

**Installation details.**
- The CLI installs globally (`npm i -g`) or as a single binary built with `bun build --compile`.
- `review install` writes one `pre-push` hook. Worktrees share hooks with the main checkout, so every worktree gets it. If a `pre-push` hook already exists, it adds one line instead of replacing it. Halo has no hook manager and no existing hooks.
- The skill that explains the gate, `review`, and `review reply` can be installed with `npx skills add`, which knows each agent's skill folder.

### 6. `.review.json`

One file per repository, at its root. It has two jobs:
1. **Opt-in switch.** The gate acts only in repositories that have it. Elsewhere, pushes pass even with the hook installed and `REVIEW_GATE=1` set.
2. **Repository-specific settings** that the tool cannot guess.

| Field | Required | Purpose |
|---|---|---|
| `tests` | No (default `[{ "runner": "vitest" }]`) | Test runners in order. Each entry has a `runner` (`vitest`, `playwright`, or `command`), an optional `dir` and `match` that choose its test files, an optional `build`, and for `command` a `run` with `{files}` and an optional `lcov`. The first entry that fits a test file runs it. |
| `exclude` | No | Extra paths that are not source code, such as committed generated code. Defaults are in "Default exclusions". |
| `instructions` | No | Files with the repository's review rules. Defaults to `AGENTS.md` and `CLAUDE.md`. |

A repository whose tests all run on Vitest needs only `{}`. The README in `code-review-agent` documents each runner.

### 7. Review surfaces

**Whiteboard:**
- The review targets the merge-base and the side commit's SHA. It pins the SHA, and the permanent `refs/tmp-tests/<branch>` ref keeps that SHA fetchable from GitHub.
- Diff-view lenses:
  - **Feature code**;
  - **Durable tests**;
  - **Temp tests (not merged)**;
  - **Coverage report**.
- A "Coverage" section shows uncovered or exempt lines as `code_peek` blocks.

**Diffmap:**
- The walkthrough embeds the patch from `git diff head tmp-tests/<branch>` as a `source-diff` inside a collapsible block. The patch text is stored in the walkthrough, so it does not depend on the ref.
- Today, collapsing needs an `html` `<details>` fence. Adding a native `collapsed` fence attribute to the custom viewer patch (`.agents/skills/diffmap-compare/assets/custom.patch`) is optional.

**PR description.** It links the side commit and gives the coverage totals.

### 8. Durable-suite pruning (Halo, separate stack)

1. Record coverage per durable test. Rank tests by the coverage that only they provide.
2. The reviewer proposes a durable keep-list by judgment. There are no fixed size targets, but the list should be small, and unit tests should cover only pure invariants.
3. Delete the rest. Git history keeps them.
4. Fix the misclassified `client`, `logger`, and `halo-cli` scripts.
5. Decide whether `check.yml` runs a small durable E2E smoke set on every PR.

## Implementation order

**Review tool repository:**
1. **CLI skeleton and coverage:** `.review.json` loading, `review coverage` (git diff, durable and temp runs, lcov merge, exemptions), and `review coverage --check`.
2. **Side ref:** `review tmp-tests publish` and `fetch`, with chained side commits.
3. **Reviewer:** the Pi session, read-only tools, `submit_verdict`, and the `review` command for one round.
4. **Loop and gate:** round state, `review reply`, the 5-round cap, `review gate` with `REVIEW_GATE` and marker detection, and `review install`.
5. **Setup:** `review login`, `review doctor`, the `review connect` and `review init` prompts, the skill, and the `AGENTS.md` text.
6. **Review surfaces:** the Whiteboard lenses and coverage section, and the Diffmap collapsible section.

**Halo PR stack:**
1. **Test tiers:** the `.tmp-tests` gitignore rule, `@vitest/coverage-v8` for each Vitest version, and the testing-conventions update.
2. **Review tool setup:** `.review.json` and the `AGENTS.md` push-gate section. This depends on review tool steps 1–4.
3. **Electron coverage:** main-process and renderer V8 coverage in Playwright.
4. **(Separate stack) Durable-suite pruning.**

## Decisions

1. **Reviewer model:** Claude Opus 5.5 (`claude-opus-5-5`) by default.
2. **Where the loop runs:** only locally. CI does not run the review loop.
3. **Side refs:** in each repository under `refs/tmp-tests/*`, never deleted.
4. **Coverage exemptions:** allowed with a `// coverage-exempt: <reason>` comment that the reviewer accepts.
5. **Durable test budget:** none. Agents choose durable or temp by judgment, and most tests should be temp tests.
6. **Packaging:** a standalone CLI in a separate repository, not a plugin.
7. **Trigger:** a `pre-push` gate that applies only to agent pushes, not a stop hook.
8. **Repository:** `cashew-labs/code-review-agent`.
9. **Anthropic credential:** your Claude Pro/Max login through Pi's OAuth flow.
10. **Setup:** two pasted prompts, `review connect` per agent and `review init` per repository. The gate's main switch is `REVIEW_GATE=1`, with agent markers as a fallback.
11. **Coverage runs:** only the changed durable test files, then every temp test. An existing test counts only once edited; agents add temp tests instead of no-op edits.
12. **`.review.json`:** a `tests` list of runners that the tool runs itself, so repositories need no test scripts for it; `exclude` and `instructions` are optional.

## Open questions

None that block implementation. Two checks happen during implementation:
- the OpenCode and Pi agent markers, by having each agent run `env`;
- whether Pi 1.0.0 lists `claude-opus-5-5`, or whether the tool must define the model metadata itself.
