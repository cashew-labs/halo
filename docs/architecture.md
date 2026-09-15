# Halo architecture

Use this guide to decide where code belongs, what a service owns, and how to test
a change. It describes the target architecture. The [current gaps](#current-gaps)
identify work still needed; the target package map is not the current file tree.

Apply these boundaries to new work and improve existing code in small steps.
Review changes against this guide. There is no custom architecture analyzer or
architecture-specific CI gate. See [AGENTS.md](../AGENTS.md) for coding rules and
verification commands.

## Put code with its owner

A **service** owns behavior and state. A **host** supplies the runtime, external
capabilities, configuration, and process lifecycle. An **adapter** connects a
service's interface to a platform or client protocol.

| Target location                                      | Responsibility                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apps/control-plane`                                 | Read production configuration, construct host adapters, start the control plane, and handle process shutdown.                      |
| `apps/workspace-server`                              | Start the workspace service with its host adapters; publish connection information and handle process shutdown.                    |
| `apps/electron`, `apps/web-app`                      | Start the desktop or browser host and mount the shared product UI.                                                                 |
| `packages/control-plane`                             | Own authentication, workspace provisioning policy, gateway behavior, and service contracts. Planned extraction from the app.       |
| `packages/workspace-server`                          | Own workspace files, sessions, tools, integrations, extensions, and their public server behavior. Planned extraction from the app. |
| `packages/client`                                    | Own product protocol types, client construction, and consumer-visible state handling. Planned package.                             |
| `packages/web`                                       | Own shared React product UI and the capabilities it needs from its host.                                                           |
| `packages/halo-cli`                                  | Adapt product CLI commands to the same operations used by other product clients.                                                   |
| `packages/extension-sdk`, `packages/extension-tools` | Own extension-facing APIs, scaffolding, and build tools.                                                                           |
| `packages/shared`, `packages/logger`                 | Own small reusable runtime primitives and logging. Keep product domain behavior with its service.                                  |
| `infra/`                                             | Own infrastructure and deployment configuration.                                                                                   |
| `tools/` and tooling packages                        | Own repository development and build tooling, not product behavior.                                                                |

Apps depend on packages. Reusable packages do not import apps or their source
files. Keep package dependencies acyclic. Import another package through its
supported entry point; internal file layout is not a public API.

Each reusable package has one supported root entry, `exports["."]`, which may
export several related symbols. The extension SDK currently retains its
runtime-separated subpaths: combining browser and server entry points would pull
runtime-specific dependencies into the wrong consumer. This is an explicit
exception, not a model for new packages.

Keep a service, its helpers, and its implementation-owned types in the same
domain folder. Split services by responsibility and state ownership, not length.
For example, after the control-plane extraction:

```text
packages/control-plane/src/auth/
  AuthService.ts    # Auth behavior and the types it owns
  callback.ts       # Auth callback helper
apps/control-plane/src/
  main.ts           # Construct hosts and start the service
  config.ts         # Read environment, arguments, and secrets
```

## Make dependencies and lifecycle explicit

Importing a reusable package must not read deployment configuration, open files,
start listeners, or construct mutable service instances. The host reads inputs
and passes explicit dependencies and configuration to the service.

Define a narrow capability interface where effects cross a host boundary: file
I/O, process execution, browsers, credentials, inference, storage, or provisioning.
The consuming service owns that interface. Hosts supply concrete adapters. Use
third-party libraries directly for deterministic utilities; do not wrap every
library or create a universal platform interface.

Use constructors for synchronous dependency assignment. Use asynchronous
`start()` or `create()` when startup acquires fallible resources. Acquire children
in dependency order, register cleanup immediately, and return only a usable
service. The owner closes children in reverse order, including on failed startup.
Use the errore disposable-stack pattern described in [AGENTS.md](../AGENTS.md#error-handling-erroreorg).

Expected application failures return typed errors. Convert expected exceptions
from external APIs at that boundary, preserving their cause. Callers check
`instanceof Error` and return early. Convert errors to transport responses or
throws only where the consumer protocol requires it. Do not catch unexpected
exceptions or add speculative retries and fallbacks.

## Give state one owner

Keep mutable runtime state on service instances, including windows, clients,
OAuth callbacks, and pending saves. Immutable module-level data is fine. A shared
resource with a lifecycle needs an explicit owner, not a hidden global cache.

Externally observable mutable state has one stream-owned source of truth.
Consumers derive views from snapshots and events rather than keeping separately
updated copies. Methods issue commands; streams publish state. Private queues,
locks, in-flight operations, and caches need not be streams when consumers do not
observe their intermediate states.

Use a `SerialQueue` per state owner when operations require ordering. Keep model
calls and subscription lifetimes off queues needed to cancel or control them.
Follow the [queue rules](../AGENTS.md#operation-serialization) for nested work.

Humans and agents use the same workspace state. Store Halo and Pi workspace state
in the chosen workspace filesystem, including workspace application data under
`.halo/`; do not create a second agent-only state store.

## Share product operations across clients

The UI, agent tools, CLI, SDK, and MCP adapters use the same product operations:
inputs, validation, errors, state changes, and events. An in-process adapter can
call the owning service; a remote client uses the public protocol. Neither should
bypass the operation by reaching into a lower-level service.

Shared access does not mean identical permissions. Declare each client's
authority explicitly. Keep product/workspace access separate from trusted
development control such as starting processes or driving Halo's renderer.
The product CLI must not give workspace agents those host-control powers.

Test-only setup belongs in the fixture or test host. Do not expose test-only
procedures through the product API, even behind a runtime flag.

## Compose environments at the host

Development, tests, staging, and production run the same service packages.
Select adapters and configuration at startup rather than branching on the
environment inside domain services.

- Development uses real local services and isolated run directories with explicit
  identities, paths, and logs. Run isolation is planned, not yet implemented.
- Tests use real local dependencies, temporary workspace roots, and controlled
  external providers where needed, such as OAuth or model inference.
- Staging and production use the same production adapter implementations with
  different configuration and accounts.

Development commands and test fixtures share programmatic host-construction and
lifecycle helpers. Tests do not invoke the dev CLI or import app internals;
the dev CLI does not depend on a test runner.

Deploy required database schema changes first, then the control plane, then
workspace servers, then activate the web client and publish desktop. Client
activation must wait for its servers. This guide does not add a migration system
or require backward-compatibility layers for unreleased local/test data.

## Test each package through one E2E fixture

Every package tests its behavior end to end through its actual consumer boundary.
Use Vitest for server and library APIs and Playwright for UI. E2E describes the
boundary, not the runner: library API-to-output tests do not need Electron.

Each package has one canonical test entry and E2E fixture. Control-plane auth,
routing, proxying, and lifecycle scenarios all use `controlPlane`, not an
auth-only fixture. Feature files and helper modules may remain separate, but
feature-specific `test.extend(...)` exports are not additional allowed test forms.
Compose external drivers, extra clients, lifecycle controls, and lazy setup
behind the same fixture without replacing internal sub-services.

Unit tests are allowed only for a small, encapsulated component that could stand
as its own package, such as an interesting data structure. Identify its independent
contract and extraction trigger. If it outgrows that scope or another package
needs it, extract it; its tests become the new package's E2Es. Purity, an exported
helper, or test convenience alone does not qualify.

Assert consumer-visible results. Workspace files can be observable outcomes when
humans or agents access them directly; internal database rows and calls between
sub-services are implementation details. Preserve meaningful coverage while
moving scenarios to the canonical fixture. See the [testing skill](../.agents/skills/testing/SKILL.md)
for fixture and workflow guidance.

## Current gaps

These gaps were checked against `2b09be8`. The phase links point to the local
migration plan in Git-ignored `specs/`, which may be absent in another checkout.
The rules above stand on their own; update this table as migrations land.

| Current evidence                                                                                                                                                                                                                                                        | Planned change                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`shared/contract.ts`](../packages/shared/src/contract.ts) mixes product, dev-control, and test procedures. Agent file tools are wired to lower-level services in [`HaloServer`](../apps/workspace-server/src/server/HaloServer.ts).                                    | Separate authority and create the common product client; align agent operations ([phases 2–3](../specs/repo-conventions-migration.md#phase-2-create-the-single-product-client-contract), [phase 8](../specs/repo-conventions-migration.md#phase-8-align-agent-tools-with-the-product-application-services)).         |
| [`packages/config`](../packages/config/src/workspaceServer.ts) loads configuration during import. Reusable [`ControlPlane`](../apps/control-plane/src/server/ControlPlane.ts) and [`HaloServer`](../apps/workspace-server/src/server/HaloServer.ts) still live in apps. | Move configuration to hosts and services to packages ([phases 4–6](../specs/repo-conventions-migration.md#phase-4-remove-import-time-configuration-and-environment-effects)).                                                                                                                                        |
| [`shared`](../packages/shared/package.json), [`web`](../packages/web/package.json), and [`workspace-server`](../apps/workspace-server/package.json) expose multiple subpaths.                                                                                           | Normalize public roots; retain the documented SDK exception ([phase 7](../specs/repo-conventions-migration.md#phase-7-normalize-package-public-entry-points)).                                                                                                                                                       |
| [`ToolRuntime`](../apps/workspace-server/src/agent/runtime/ToolRuntime.ts) combines several domains and owns a global QuickJS promise. [`Electron main`](../apps/electron/src/main/main.ts) owns mutable state at module scope.                                         | Separate host capabilities, service responsibilities, and state owners ([phases 9–12](../specs/repo-conventions-migration.md#phase-9-introduce-narrow-host-capabilities-at-real-variability-points)).                                                                                                                |
| [`pnpm dev`](../package.json) shares `tmp/workspace/.halo` across runs.                                                                                                                                                                                                 | Add explicit run identity and isolation ([phase 13](../specs/repo-conventions-migration.md#phase-13-build-an-isolated-development-run-host-and-cli)).                                                                                                                                                                |
| [`AuthService.test.ts`](../apps/control-plane/test/AuthService.test.ts), [`oauth.test.ts`](../apps/workspace-server/test/oauth.test.ts), and [`extensionE2eTest.ts`](../apps/electron/e2e/extensionE2eTest.ts) use separate test compositions or entries.               | Consolidate each package's fixture and assess narrow component exceptions ([phase 5](../specs/repo-conventions-migration.md#phase-5-extract-the-reusable-control-plane-package), [phases 14a–14d](../specs/repo-conventions-migration.md#phase-14a-move-workspace-oauth-scenarios-to-the-canonical-server-fixture)). |
| The proposed product client package and its SDK/MCP adapters are not yet present.                                                                                                                                                                                       | Add adapters over the common product API ([phase 15](../specs/repo-conventions-migration.md#phase-15-add-sdk-and-mcp-adapters-over-the-same-client)).                                                                                                                                                                |
| The [control-plane image](../apps/control-plane/Dockerfile) includes the web bundle, activating it before workspace rollout finishes.                                                                                                                                   | Separate web-client activation from backend deployment ([phase 16](../specs/repo-conventions-migration.md#phase-16-make-database-migration-and-client-activation-explicit-release-layers)).                                                                                                                          |
