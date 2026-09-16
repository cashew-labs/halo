# Halo

Halo is an open-source self-modifiable desktop app built with Electron and Pi. It's currently a work-in-progress and has not been publically launched.

## Conventions

Use the [conventions skill](.agents/skills/conventions/SKILL.md) when writing,
refactoring, or reviewing code or tests. Read its relevant pages, not the whole
handbook for every task. Track repo-specific progress in
`specs/repo-conventions-migration.md` and update it as changes land; do not expand
a task into the full migration.

## Commands

- `pnpm run check-affected` - Lint, typecheck, format-check, and run unit tests for affected packages using Turbo's default concurrency. Use it during iteration and before handing off a change. It does not run E2Es or package Electron. GitHub Actions runs the same command on pull requests and on pushes to `main`.
- `pnpm run test:e2e` - Run E2Es for affected packages separately. This can package Electron and install test dependencies. During iteration, run only the relevant package or test file; do not run the full E2E command unless requested or needed for the change.
- `pnpm run test:e2e:release` - Run all package E2Es without Turbo cache reuse. CI runs this only on release PRs; `Release ready` requires it to pass. Ordinary PRs and post-merge release jobs do not run E2Es.
- For Electron E2Es, build with `pnpm --filter @get-halo/desktop test:e2e:build` after app code changes, then use `pnpm --filter @get-halo/desktop test:e2e:run <test-file>` to reuse that package while editing tests. Electron E2Es use Playwright's default of half the logical CPU cores; pass `--workers=1` to reduce resource usage.
- `pnpm spec <file>` / `pnpm walkthrough <file>` / `pnpm exec tkstack <file>` - Serve a spec or code walkthrough as a local tkstack page.

## Releasing

Run `pnpm prerelease <version>` from a clean, up-to-date `main` branch. It creates and opens a release PR that bumps the desktop version and pins the production images. CI tests the PR and previews Pulumi. Merging deploys the control plane and workspace VMs before publishing the desktop application and matching GitHub tag. Packaged apps check for updates via `update.electronjs.org`.

## Code Style

- Prefer explicit, straightforward code. Don't use fallbacks. Avoid patterns like `||` and `??`.
- Use `undefined` for missing values, not `null` (`unicorn/no-null`). This differs from errore.org's `| null` default. Keep `null` only where an external API uses it (JSON `null`, DOM, Electron, Cap'n Web). Compare those values with `=== null`; the lint rule allows that.
- Don't support backwards-compatibility unless explicitly asked to.
- Simplify as you go. When you touch code, remove nearby indirection, compatibility paths, defensive branches, unused helpers, or duplicated state that no longer serve the current design. Simplification is iterative: after removing one unnecessary condition or abstraction, look again for variables, branches, helpers, or comments that only existed to support it.
- Don't over-worry. Avoid guard clauses, `if`/`throw`, retries, fallback values, and defensive checks unless the user asked for them or you know a specific error can happen and this layer is responsible for handling it. When handling a known external quirk, add a short comment that names the source of the behavior.
- Local code should have local worries. Do not compensate in one place for sub-optimal behavior in another place when the link is not direct. Step back, identify the ownership boundary, and consider a cleaner design instead.
- Prefer explicit types; avoid `any`.
- Put types in the same file as the implementation that owns them.
- Prefer TypeScript `private` / `private readonly` over `#` private fields, matching the rest of the codebase.
- TypeScript uses strict mode with `noUncheckedIndexedAccess` enabled.
- ESM imports use `.js` extensions even for TypeScript files.
- Workspace packages use the `@get-halo/*` naming convention.
- File names: no hyphens. Name a file after its primary export and use the export's casing. Classes, types, interfaces, enums, and React components use PascalCase. Functions and values use camelCase. When no single export owns the module, name it after the shared concept in camelCase (or a single lowercase word when the surrounding folder supplies enough context). Tests mirror the implementation file's name.
- Folder names: use a single lowercase word when practical. Put a service in a domain folder alongside its helpers, such as `auth/AuthService.ts` and `auth/callback.ts`. Keep package directories and framework-defined paths in their required conventional form.
- Generally, avoid comments that restate the code. Add comments for class-owned state as described below, and for external context that is not easily traced back (e.g. external dependency behavior or explicit business logic decisions).
- Ignore migrations or backwards-compatability - Halo is unreleased and pre-1.0 so we can break/rebuild anything as necessary.

### Class layout

- Declare internal state at the top of the class. Add a short comment to each state field explaining what it tracks or coordinates.
- Declare constructor-supplied dependencies and configuration next, as explicit `private readonly` fields. These context fields do not need comments.
- Constructors take one `ctx` object. Destructure it and explicitly assign its values to the instance fields; do not store the whole context object or use constructor parameter properties.

### Operation serialization

- Use `SerialQueue` from `@get-halo/shared/SerialQueue` for operations that must run sequentially. Keep a queue per state owner instead of hand-written Promise chains or a global server queue.
- Name a class's single queue `actionQueue`. When a class has multiple queues, name each `<purpose>Queue`, such as `writeQueue` or `reloadQueue`.
- Public methods that require serialization keep semantic names, such as `reload()` or `close()`. Inline the operation in the queue callback unless its implementation is shared. Name shared private operation implementations `*Unqueued`, such as `updateGrantsUnqueued()`, to show that they execute directly.
- Queued operations and their helpers never enqueue on the same queue or call public methods that do. Call the shared `*Unqueued` implementation when composing work already inside the queue; awaiting a nested enqueue would deadlock.
- Queue only the work that needs ordering. Long-running model calls, tool executions, and subscription lifetimes must not hold a queue needed to cancel or control them.
- `SerialQueue.run()` preserves the operation's return value or rejection and allows later operations to run after a failure. Error conversion belongs at the service's external-library boundary.

### Testing

Don't write tests unless updating tests or writing new ones in existing test files or asked.

For test changes or review, use the conventions skill and read its
[testing page](.agents/skills/conventions/references/testing.md).
Control-plane auth, routing, proxying, and lifecycle scenarios all use
`controlPlane`. Existing alternate fixtures are migration work, not examples
to copy. See Commands above for this repo's focused verification commands.

## Working Style

- Summarize changes with concise, source-checked call stacks and name the next small step. Manual summaries in chat are enough.
- Store temporary files and workspaces in a named folder under this repo's `tmp/` directory.
- Garden as you go. When the current work exposes small, clear friction—such as incorrect guidance, stale docs, misleading comments, dead code, or a confusing local API—fix it in the same change and verify the fix. If the issue is too large, risky, or separate to finish well in the current session, do not derail the main task; note it and discuss or scope it as follow-up work.
- If straightforward code seems to need surprising guards, wrappers, assertions, or other ceremony, stop and research how the dependency's own code and reference projects handle the same case before keeping that shape.
- When working on issues that seem like they would be common (e.g. issues hooking up popular libraries to each other), do research into the Github issues of those repos or research code of projects that use the same libraries. Here's some reference projects you can look at:
  - Craft Agents: https://github.com/craft-ai-agents/craft-agents-oss. Uses Electron, Pi (`@mariozechner/pi-coding-agent`), Vite, and esbuild.
  - bb: https://github.com/get-bb/bb. Electron + Vite + React agent IDE with a plugin system (`package.json` + nested `halo`).
  - Prime Agent: https://github.com/PrimeIntellect-ai/prime-agent

## Error handling (errore.org)

This codebase uses the [errore.org](https://errore.org) convention. Always read the `errore` skill (`.agents/skills/errore/SKILL.md`) before editing TypeScript that handles failures. Always `import * as errore from 'errore'`.

- If the failure is expected and comes from app code, return an `Error` (prefer `errore.createTaggedError`) instead of throwing. Callers check with `instanceof Error` and early-return.
- If the failure is expected and comes from external library code (or other throwing APIs such as `JSON.parse`, `fetch`, file I/O), convert at that boundary with `errore.try` (sync) or `.catch((e) => new MyError({ cause: e }))` (async). Prefer `.catch()` over `errore.tryAsync`.
- Do not catch unexpected exceptions. When one shows up, pick a strategy for that case.
- Replace `try`/`finally` resource cleanup with `await using` + `errore.AsyncDisposableStack` (or `using` + `errore.DisposableStack`) when cleanup is needed.
- At legacy boundaries that still require throws (for example Electron IPC rejection), convert a returned error back to a throw only at that edge: `if (result instanceof Error) throw result`.

## Design Guidance

- Agents and humans should always have access to the same state. Store Halo and Pi state in the chosen workspace filesystem.

## Cursor Cloud specific instructions

Development runs the independent control plane and workspace server Node services with the Halo Electron client. Start all three from the repo root with `pnpm dev`; they use `tmp/workspace` as the workspace and `tmp/workspace/.halo` for shared application data. The `halo-dev` terminal in `.cursor/environment.json` already runs this. The control plane and workspace server publish their connection information under that application data directory, Electron serves the Vite renderer and opens its window, and dev builds expose Chrome DevTools Protocol on `127.0.0.1:4445`. Drive and inspect the renderer with `pnpm halo-dev app` (see the halo-app skill). Follow the incremental verification workflow in Commands.

Cursor Cloud agents must record a short demo video when they add or change any UI, attach it to the PR, and show it in the walkthrough. Use screen recording against the running Halo app; do not skip this for “small” UI tweaks. This requirement does not apply to agents outside Cursor Cloud.

Dev Agentation notes sync through the `agentation-mcp` terminal (`127.0.0.1:4747`). Query pending notes with `GET http://127.0.0.1:4747/pending`. Cursor loads the same server from `.cursor/mcp.json`.

GCP infrastructure lives in `infra/control-plane/` and `infra/workspace/` (Pulumi). Use `pnpm infra:control-plane:preview`, `pnpm infra:control-plane:up`, `pnpm infra:workspace:preview`, and `pnpm infra:workspace:up`.

Headless hosts (Xvfb/VNC) need `HALO_USE_SWIFTSHADER=1`, which the `halo-dev` terminal exports. Without it the renderer cannot start WebGL.

To chat with a model, authenticate to GCP with Application Default Credentials. The workspace server uses its ADC identity to call `google-vertex/gemini-3.8-flash` in project `halo-relay`; production VMs receive that access through their attached service accounts.

Configure the workspace when starting the workspace server with `HALO_WORKSPACE_ROOT`, or pass a JSON configuration to `pnpm server <config.json>`. Electron has no workspace picker and never starts or stops the server. In development all services use `<repo>/tmp/workspace/.halo`. The workspace server publishes `server.json` for Electron and `rpc.json` for the CLI. Closing Electron leaves active sessions and extensions running. See `apps/workspace-server/README.md`.

`.halo/` holds dev userData and is gitignored. Starting the workspace server seeds `halo-extension` and `maui` under `{workspace}/.agents/skills/`. Halo loads skills only from that directory and root instructions only from the workspace's `AGENTS.md`; Pi session state and Executor data share `{workspace}/.halo/state.db`, owned by `WorkspaceServer` through `DatabaseClient`. Workspace extensions are trusted and can call every available tool through their server-issued token. Agents use the single workspace Maui skill. Build inside the extension with `npm run build`, then use `halo extension reload` to start newly discovered extensions and reload the renderer to refresh the sidebar. Existing extension servers keep their current build until the workspace server restarts.
