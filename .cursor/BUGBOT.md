# Halo review rules

Flag every violation of these conventions in the PR diff. They are required
design, not optional style. Source: `.agents/skills/conventions/` (PR 186).
Do not invent extra rules. Name the violating symbol or import in each Bug.

## Packages

If the PR adds a package that only forwards another library, shares a few
lines, or exists so an internal test can be called an E2E:

- Add a Bug titled "Package has no consumer contract"
- Body: "Create a package only for a cohesive public API. Use Playwright or
  `libretto-browser-tools` directly when they already supply the abstraction."

If a reusable package imports from `apps/`, or a consumer imports a
package-internal file instead of the package root (except a documented
runtime-split export):

- Add a Bug titled "Package boundary leak"

If deployable host code lands under `packages/`, reusable services or UI land
under `apps/`, or deploy config lands outside `infra/`:

- Add a Bug titled "Wrong layer for this code"

## Product API vs development control

`@get-halo/client` is the product contract, client, and session reducers.
`@get-halo/app-control` and the development CLI are not product API. Electron
owns the development app-control listener, credentials, and lifecycle.
Workspace browser automation stays a product capability on the workspace
server. Closing Electron must not stop that server or its browsers.

If product client, workspace CLI, or workspace-server code adds Electron
app-control, debug-port automation, or a development-only listener:

- Add a Bug titled "Development control leaked into the product API"

If Electron or app-control code sends renderer automation through the
workspace server or product Halo RPC:

- Add a Bug titled "App control used the product RPC"

If workspace browser open, exec, snapshot, or screenshot moves off the
workspace server or `@get-halo/client`:

- Add a Bug titled "Workspace browsers left the product API"

If the PR wraps Playwright or `libretto-browser-tools` in a pass-through
helper or package:

- Add a Bug titled "Needless browser-tools wrapper"
- Body: "The owning service still owns page lifetime, permissions, error
  conversion, and screenshot paths. Do not add a forwarding layer."

If importing a reusable package reads deployment config, environment
variables, or disk, or starts a service:

- Add a Bug titled "Import has host side effects"

If a caller supplies the IPC or browser bridge that the host should
construct, or a host fails to own its private bridge state:

- Add a Bug titled "Host does not own its bridge"

## Services and state

If two owners each construct the same shared child (for example two database
clients for one file) instead of the lowest common owner constructing it
once, or sharing is done with a process-global singleton:

- Add a Bug titled "Shared child has no single owner"

If a second path reaches the same product operation while skipping its
owning service (UI, agent, CLI, SDK, and MCP must share that service;
transports and permissions may differ):

- Add a Bug titled "Bypassed owning service"

If mutable runtime state or clients live in module globals instead of on the
service or host instance:

- Add a Bug titled "Mutable state is not instance-owned"

If consumer-visible state is updated in a second copy instead of a derived
stream or view, or commands do not go through methods that publish on
streams:

- Add a Bug titled "Duplicated consumer state"

If sequential work uses a hand-written Promise chain or a process-wide queue
instead of a per-owner `SerialQueue`; if already-queued work enqueues on the
same queue; or if a control queue is held across a model call, tool run, or
subscription:

- Add a Bug titled "SerialQueue misuse"
- Body: "Use `actionQueue` or a purpose-named queue. Shared private work is
  `*Unqueued`. Do not nest enqueue. Do not block cancel/control."

If humans and agents would no longer share the same workspace-filesystem
product state, or local development credentials and artifacts are stored
away from their owning host:

- Add a Bug titled "State store split from its owner"

## Environments and tests

If domain code branches on environment instead of receiving a host
implementation and config at startup:

- Add a Bug titled "Environment branch in domain code"

If a test fixture shells out to the development CLI, or a CLI imports a test
runner:

- Add a Bug titled "CLI and fixtures are coupled"

If E2Es or Electron packaging are folded into `check-affected` / `pnpm check`:

- Add a Bug titled "E2Es mixed into static checks"

If a package test imports a private module, starts an unneeded server, or
mocks an internal service:

- Add a Bug titled "Test left the consumer boundary"
- Body: "Package tests are E2Es through the main supported export. Control
  unavailable externals at the host boundary."

If the PR adds a second fixture that mounts an internal subset, or a new
internal unit test whose contract could not stand as its own package:

- Add a Bug titled "Non-canonical test setup"

If assertions check internal spies, private database rows, or removed APIs
instead of consumer-visible results (including files a consumer can read):

- Add a Bug titled "Assertion is not consumer-visible"

## TypeScript and errors

If a constructor keeps the whole `ctx` object, uses parameter properties, or
skips assigning destructured fields; or owned state is not declared first
with a short comment, followed by `private readonly` dependencies:

- Add a Bug titled "Class layout hides ownership"

If an expected failure is thrown or swallowed instead of returned as
`Value | DomainError` with an `instanceof Error` early return; if `try/catch`
wraps a whole workflow instead of converting the throwing call at its
boundary (`errore.try` sync, `.catch` async, `cause` preserved); or if
`try/finally` replaces `using` / `await using` with errore disposable
stacks:

- Add a Bug titled "errore boundary violated"
