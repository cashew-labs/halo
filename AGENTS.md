# Halo

Halo is an open-source self-modifiable desktop app built with Electron and Pi. It's currently a work-in-progress and has not been publicly launched.

## Skills

Use the [conventions skill](.agents/skills/conventions/SKILL.md) when writing, refactoring, or reviewing code or tests. Read its relevant pages, not the whole handbook for every task. Track repo-specific progress in `specs/repo-conventions-migration.md` and update it as changes land; do not expand a task into the full migration.

When editing TypeScript that handles failures, also read the [errore skill](.agents/skills/errore/SKILL.md).

## Code Review Rules

Codex GitHub review and `codex review` follow this section. The conventions handbook at `.agents/skills/conventions/` is the source of truth. Start at `SKILL.md`. Read only the reference pages that apply to the changed files.

If the diff introduces a violation of those pages:

- Treat it as P1 so GitHub review posts it. Treat a new package, authority, or persistent-state boundary that contradicts the handbook as P0.
- Cite the page path and the violating symbol or import.
- Do not restate the handbook in the comment.
- Do not invent extra rules.
- Do not flag pre-existing mismatches that the change does not expand. Those are tracked in `specs/repo-conventions-migration.md`.
- Leave formatting, lint, and typecheck to CI.

Apply the change in front of you. Do not require a repo-wide conventions migration.

### Packages

Source: `.agents/skills/conventions/references/packages.md`

- Do not add a package that only forwards another library or exists so an internal test can be labeled an E2E.
  Safe path: call the library from the owning service.
- Keep deployable hosts in `apps/`, reusable code in `packages/`, and deployment configuration in `infra/`. Reusable packages must not import app internals.
  Safe path: move shared behavior into a package, or keep host-only code in the app.
- Consumers import a package's supported public entry, not internal files.
  Safe path: export the needed contract from the package root, or document a runtime-split export.

### Services

Source: `.agents/skills/conventions/references/services.md`

- Human UI, agents, CLI, SDK, and MCP must reach the same owning service for a product operation. Do not add a parallel path that bypasses it.
  Safe path: add a transport or permission check, then call the existing operation.
- A shared dependency has one owner. Children borrow it. Do not open a second connection, database, or listener for the same resource, and do not move it into a process-global singleton.
  Safe path: construct the resource in the lowest common owner and pass it in.
- Importing a reusable package must not read deployment configuration, touch disk, or start services.
  Safe path: the host supplies capabilities and configuration at startup.
- Test-only authority belongs on an explicit `testApi` namespace, gated by a startup option that is disabled by default.
  Safe path: enable `testApi` in fixtures; keep it off in normal hosts.

### State

Source: `.agents/skills/conventions/references/state.md`

- Keep mutable runtime state on service instances, not module globals.
  Safe path: own the client or cache on the host or service instance.
- Humans and agents share the same product state. Do not add an agent-only store for workspace data.
  Safe path: persist in the chosen workspace filesystem.
- Use `SerialQueue` from `@get-halo/shared/SerialQueue` for ordered mutations. Name a class's single queue `actionQueue`. Public methods stay semantic. Already-queued work calls `*Unqueued` helpers and must not re-enter a method that enqueues on the same queue.
  Safe path: inline the ordered work, or extract `*Unqueued` when it is shared.
- Do not hold the control queue across long-running model calls, tools, or subscriptions.
  Safe path: enqueue setup or state commits only; run the long work off-queue.

### TypeScript and errors

Source: `.agents/skills/conventions/references/typescript.md`

- Halo is pre-1.0. Do not add compatibility shims or migration branches unless the task requires them.
  Safe path: rebuild obsolete state.
- Expected failures return `Value | DomainError` with `errore`. Do not throw expected failures or wrap them in a Result type. Import `errore` as a namespace. Convert throwing external APIs at the call boundary with `.catch()` or `errore.try`, not a `try`/`catch` around the whole operation.
  Safe path: return tagged domain errors with `cause`; `instanceof Error` early-return on the caller.
- Use `using` / `await using` with `errore.DisposableStack` or `errore.AsyncDisposableStack` for cleanup, not `try`/`finally`.
- Use `undefined` for absence. Keep `null` only at external APIs that require it.

### Tests

Source: `.agents/skills/conventions/references/testing.md`

- Drive package tests through the public exports. Do not import private modules or expose internals solely to test them.
  Safe path: test the consumer API. Extract a package only when the internal contract could stand alone.
- Use one canonical fixture per package. Do not add alternate fixtures that mount an internal subset.
  Safe path: extend the existing fixture, or use a runtime-gated `testApi` on the normal client.
- Assert consumer-visible results. Do not assert spies on internal calls or private database rows.
- Do not mock internal services. Control unavailable externals at the host boundary.

### Environments

Source: `.agents/skills/conventions/references/environments.md`

- Do not read arguments, environment variables, files, or secrets by importing a reusable module.
  Safe path: read configuration in the host startup function and pass it in.
- Test fixtures call the same programmatic host APIs as development. They must not shell out to the development CLI.

### Research

Source: `.agents/skills/conventions/references/research.md`

- Flag new wrappers, retries, fallbacks, or compatibility logic around an external dependency when the diff does not show that the dependency requires them.
  Safe path: call the library directly, or cite the dependency behavior that makes the ceremony necessary.

## Writing Rules

Always adhere to ISO 24495-1 Technical Language Standard for responses, except the 80-column layout instruction.

Use the [logos skill](.agents/skills/logos/SKILL.md) when adding product or
integration marks. Download them from [SVGL](https://svgl.app/) into
`apps/web-app/public/logos/` and reference `https://gethalo.dev/logos/`.

## Commands

- `pnpm run check-affected` - Lint, typecheck, format-check, and run unit tests for affected packages using Turbo's default concurrency. Use it during iteration and before handing off a change. It does not run E2Es or package Electron. GitHub Actions runs the same command on pull requests and on pushes to `main`.
- `pnpm run test:e2e` - Run E2Es for affected packages separately. This can package Electron and install test dependencies. During iteration, run only the relevant package or test file; do not run the full E2E command unless requested or needed for the change.
- `pnpm run test:e2e:release` - Run all package E2Es without Turbo cache reuse. CI runs this only on release PRs; `Release ready` requires it to pass. Ordinary PRs and post-merge release jobs do not run E2Es.
- For Electron E2Es, build with `pnpm --filter @get-halo/desktop test:e2e:build` after app code changes, then use `pnpm --filter @get-halo/desktop test:e2e:run <test-file>` to reuse that package while editing tests. Electron E2Es use Playwright's default of half the logical CPU cores; pass `--workers=1` to reduce resource usage.
- `pnpm review:sync` - Prepare the latest untouched upstream Diffmap and the separately maintained custom viewer.
- `pnpm review:compare <upstream.md> <custom.md> --root <source-workspace>` - Serve both review versions on ports 4178 and 4179 when a comparison is requested. Use the [diffmap-compare skill](.agents/skills/diffmap-compare/SKILL.md) to author both documents from the same changes.
- `pnpm spec <file>` / `pnpm walkthrough <file>` / `pnpm exec diffmap <file>` - Serve a spec or code walkthrough as a local Diffmap page.
- `pnpm prerelease <version>` - Run from a clean, up-to-date `main` branch to create and open a release PR that bumps the desktop version and pins the production images. CI tests the PR and previews Pulumi. Merging deploys the control plane and workspace VMs before publishing the desktop application and matching GitHub tag. Packaged apps check for updates via `update.electronjs.org`.
- `@codex review` on a GitHub pull request starts a Codex code review. Locally, `codex review --base main` reviews the branch diff against `main`. Both follow the Code Review Rules above.

## Working Style

- Summarize changes with concise, source-checked call stacks and name the next small step. Manual summaries in chat are enough.
- Store temporary files and workspaces in a named folder under this repo's `tmp/` directory.

## Cursor Cloud specific instructions

Development runs the independent control plane and workspace server Node services with the Halo Electron client. Start all three from the repo root with `pnpm dev`; they use `tmp/workspace` as the workspace and `tmp/workspace/.halo` for shared application data. `.cursor/environment.json` defines a `halo-dev` terminal that starts this stack with ADC and SwiftShader; start it if it is not already running. The control plane and workspace server publish their connection information under that application data directory, Electron serves the Vite renderer and opens its window, and dev builds expose Chrome DevTools Protocol on `127.0.0.1:4445`. Drive and inspect the renderer with `pnpm halo-dev app` (see the halo-app skill). Follow the incremental verification workflow in Commands.

Cursor Cloud agents record a short demo video for large UI changes: new screens, layout, or interaction. Attach it to the PR and show it in the walkthrough. Record against the running Halo app. Copy, color, spacing, and other small tweaks do not need a demo. This requirement does not apply to agents outside Cursor Cloud.

Dev Agentation notes sync through the `agentation-mcp` terminal (`127.0.0.1:4747`). Query pending notes with `GET http://127.0.0.1:4747/pending`. Cursor loads the same server from `.cursor/mcp.json`.

GCP infrastructure lives in `infra/control-plane/` and `infra/workspace/` (Pulumi). Use `pnpm infra:control-plane:preview`, `pnpm infra:control-plane:up`, `pnpm infra:workspace:preview`, and `pnpm infra:workspace:up`.

Headless hosts (Xvfb/VNC) need `HALO_USE_SWIFTSHADER=1`, which the `halo-dev` terminal exports. Without it the renderer cannot start WebGL.

To chat with a model, authenticate to GCP with Application Default Credentials. The workspace server uses its ADC identity to call `google-vertex/gemini-3.8-flash` in project `halo-relay`; production VMs receive that access through their attached service accounts.

Electron development mode also uses the active ADC principal as its local UI identity, so it does not open browser Google sign-in. User ADC appears as that Google user and service-account ADC appears as the service account email. Packaged builds and the browser app still use Better Auth with Google sign-in.

Configure the workspace when starting the workspace server with `HALO_WORKSPACE_ROOT`, or pass a JSON configuration to `pnpm server <config.json>`. Electron has no workspace picker and never starts or stops the server. In development all services use `<repo>/tmp/workspace/.halo`. The workspace server publishes `server.json` for Electron and `rpc.json` for the CLI. Closing Electron leaves active sessions and extensions running. See `apps/workspace-server/README.md`.

`.halo/` holds dev userData and is gitignored. Starting the workspace server seeds `halo-extension` and `maui` under `{workspace}/.agents/skills/`. Halo loads skills only from that directory and root instructions only from the workspace's `AGENTS.md`; Pi session state and Executor data share `{workspace}/.halo/state.db`, owned by `WorkspaceServer` through `DatabaseClient`. Workspace extensions are trusted and can call every available tool through their server-issued token. Agents use the single workspace Maui skill. Build inside the extension with `npm run build`, then use `halo extension reload` to start newly discovered extensions. The sidebar updates automatically. For an existing extension, use `halo extension restart <id>` after rebuilding, then reload or reopen its pane to load the new browser bundle.
