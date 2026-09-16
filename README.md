# Halo

Halo is an Electron desktop app with a React renderer and Pi in an independent Node workspace server.

## Structure

- `apps/electron/src/renderer`: React UI built with Maui and Vite.
- `apps/electron/src/main`: Electron main process, preload bridge, and server connection discovery.
- `apps/workspace-server`: Independent workspace and agent service (`@get-halo/workspace-server`).
- `infra`: [GCP/Pulumi infrastructure](infra/README.md).
- `packages/halo-cli`: Workspace commands and private browser testing for workspace agents.
- `packages/dev-cli`: Local development commands, currently Electron app control.
- `packages/logger`: Shared structured logger.
- `packages/typescript-config`: Shared TypeScript settings.

## Local development

Install [pnpm 12](https://pnpm.io/installation) with the standalone script, not Corepack. `latest` on npm still points at pnpm 11, so pass the 12 line explicitly:

```sh
curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=12.1.0 sh -
pnpm install
pnpm dev
```

On Linux hosts without a real GPU (including Cursor cloud agents on Xvfb), set `HALO_USE_SWIFTSHADER=1` before starting Halo. The Cursor environment terminal always exports it.

```sh
export HALO_USE_SWIFTSHADER=1
pnpm dev
```

Halo reads model and authentication credentials from GCP Secret Manager at
runtime using Application Default Credentials. Follow the
[infrastructure secret setup](infra/README.md#runtime-secrets) before starting
development.

`pnpm dev` starts the control plane, workspace server, web app, and Electron independently, using `<repo>/tmp/workspace` and `<repo>/tmp/workspace/.halo`. Electron discovers the server through `server.json` in that application-data directory; closing Electron leaves the server running. When launching services individually, use `HALO_WORKSPACE_ROOT` to select the workspace and `HALO_USER_DATA` to select the application-data directory. See [workspace-server configuration](apps/workspace-server/README.md).

Halo runs Pi's `AgentHarness` with one `main` lane per conversation. `HaloServer` owns a `DatabaseClient` that stores Pi conversations and Executor application data in one embedded Turso database. The file currently lives in the selected workspace:

```text
<workspace>/
└── .halo/
    └── state.db
```

Halo's `TursoSessionRepo` implements Pi's repository contract, and `TursoStorage` implements its storage contract. Pi's `StorageBackedSession` still owns session and branch behavior. The adapter uses Pi's commit validation and fork helpers and stores data in `halo_sessions`, `halo_session_entries`, `halo_session_values`, `halo_session_lists`, and `halo_session_usage`.

`DatabaseClient` owns one Turso connection and coordinates access to it. It has no Pi or Executor dependencies. `HaloServer` constructs the session repository; `ToolRuntime` builds Executor's Fuma/Drizzle adapter and supplies it to Executor. Both reads and writes wait for admitted transactions, so neither consumer can observe the other's uncommitted changes. Transaction callbacks must use their supplied connection/query and must not wait for tools, network calls, or model inference.

The adapter uses Turso's synchronous compatibility driver and ordinary tables. Turso 0.7.2 does not support recursive CTEs, so branch scans follow indexed parent links without a separate branch-index table. The schema is bundled with Halo; there is no Pi SQLite backend dependency, package patch, or SQL asset-copy step. Existing JSONL and vendor SQLite tables are not imported.

Shutdown stops HTTP admission, closes sessions, drains request handlers, stops tools, closes the repository, then closes the database. Executor retains its generated table/index names and independent schema version. Future Halo and extension tables must avoid existing names; use `halo_*` and `ext_<installation>_*`. Extensions are trusted, so Halo does not store extension grants. Extension records and the credential vault have not moved into this database yet.

The renderer consumes Halo session snapshots and events, adapted from Pi at the server boundary. The [session protocol](packages/shared/README.md) describes stable entries, run state, and first-class nested `exec` activity. It uses Pi's supplied transcript; loading older entries before compaction is deferred. `sessions.watch` sends an initial snapshot followed by ephemeral live events; disconnecting a viewer leaves its running session active. Nested `exec` tool details persist in Pi's tool results and progress checkpoints. Halo does not keep a separate event log or import existing JSONL conversation files.

Pi's file and shell tools run on the host with the same rights as Halo. Halo does not import old AgentOS SQLite workspaces.

The workspace server reads required credentials from GCP Secret Manager. It does
not pass them through renderer IPC or extension process environments.

## Debug UI control

Development builds expose Electron's Chrome DevTools Protocol on `127.0.0.1:4445`. The separate `pnpm halo-dev` command uses Electron's local app-control connection to attach with [Libretto Browser Tools](https://libretto.sh/browser-tools) and leaves Halo running. Electron owns this endpoint; the workspace server does not. For the root dev stack:

```sh
export HALO_USER_DATA="$PWD/tmp/workspace/.halo"
pnpm halo status
pnpm halo-dev app snapshot
pnpm halo-dev app exec "return await page.locator('body').innerText()"
pnpm halo-dev app exec "await page.getByRole('button', { name: 'New session' }).click()"
```

The `halo` CLI is the workspace-facing command for agents. Use `halo browser open <url>` for an isolated extension preview, followed by `halo browser exec <id>`, `snapshot <id>`, `screenshot <id>`, and `close <id>`. Halo owns these browsers and provisions Chromium on first use.

Pass `--stdin` or `--file checks.js` for longer scripts. Output uses TOON by default; pass `--json` for JSON. Packaged builds do not expose the debug port.

## Infrastructure

Infrastructure targets GCP project `halo-relay` with Pulumi. See the
[infrastructure instructions](infra/README.md) for bootstrapping, previewing,
and deploying the production control plane and workspace images.

## Packaging

```sh
pnpm --filter @get-halo/desktop build
pnpm --filter @get-halo/desktop make
```

Electron Forge writes packaged apps to `apps/electron/out`.

## Releasing

Halo uses one release PR for its infrastructure, cloud services, workspace VMs,
and desktop application. From a clean, up-to-date `main` branch, run:

```sh
pnpm prerelease 0.1.44
```

The command creates `release/0.1.44`, bumps the desktop and production image
versions, adds `releases/0.1.44.json`, pushes the branch, and opens the PR.

The PR runs the normal repository checks and posts the production Pulumi preview.
Merging it runs `Release Halo` in this order:

1. Run the packaged macOS tests.
2. Build versioned control-plane and workspace images.
3. Apply the production Pulumi stack.
4. Check the control-plane health endpoint.
5. Recreate each workspace VM while preserving its durable data disk.
6. Create the matching tag and GitHub Release.
7. Build, sign, notarize, and publish the desktop application.

Packaged macOS and Windows builds check for updates through [update.electronjs.org](https://update.electronjs.org), which reads those GitHub Releases. macOS builds are signed and notarized in CI.

### One-time GitHub setup

Create a GitHub Environment named `Release` (name is case-sensitive) and add:

**Variables**

- `APPLE_TEAM_ID` — Apple Team ID (for example `S2ZR72G4R4`)

**Secrets**

- `APPLE_CERTIFICATE_BASE64` — base64-encoded Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD` — password for that `.p12`
- `APPLE_API_KEY_BASE64` — base64-encoded App Store Connect API `.p8` key
- `APPLE_API_KEY_ID` — App Store Connect API key id
- `APPLE_API_ISSUER` — App Store Connect issuer UUID

Do not add required reviewers to the `Release` environment. Reviewing and merging
the release PR is the production approval.

Configure GitHub Actions to authenticate to GCP through Workload Identity
Federation, then add these repository variables:

- `GCP_WORKLOAD_IDENTITY_PROVIDER` — full Workload Identity provider resource
  name.
- `GCP_DEPLOY_SERVICE_ACCOUNT` — deployment service account email.

The identity needs access to the Pulumi state bucket and KMS key, permission to
submit the existing Cloud Build configurations, and the GCP permissions required
by the production Pulumi stack. Require PR review and `Check / check-affected`
plus `Release Halo / Release ready` through the `main` branch ruleset. The
second check is lightweight for ordinary PRs and requires a successful Pulumi
preview for release PRs. For security, release PRs must use a `release/*` branch
in this repository; forks cannot access the production preview identity.

## Checks

Pull requests and pushes to `main` run `pnpm run check-affected` on GitHub Actions (`Check / check-affected`).
This runs lint, typechecking, formatting checks, and unit tests for affected
packages. It does not run E2Es or package Electron.

```sh
pnpm run check-affected
```

Run E2Es for affected packages separately:

```sh
pnpm run test:e2e
```

For a focused run, use the package's `test:e2e` command. Desktop E2Es also offer
`test:e2e:build` and `test:e2e:run <test-file> --workers=1` to reuse a build and
limit CPU usage. The release workflow still runs its packaged desktop E2Es.

Tests do not call a paid model.
