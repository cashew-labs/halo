---
name: conventions
description: Apply repository design and testing conventions when writing, refactoring, or reviewing TypeScript packages, services, state, tests, or runtime hosts. Includes package-level E2Es and fixture design.
---

# Repository conventions

Keep behavior reusable across clients and environments. Give state, dependencies, and lifecycle explicit owners. Prefer composition and direct consumer flows over layers that send work back and forth.

## Find the relevant page

Read the pages relevant to the change before editing:

| When changing                                                         | Read                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| Workspace topology, package boundaries, exports, or file organization | [Monorepo](references/monorepo.md)                           |
| Services, host interfaces, startup, cleanup, or client access         | [Services](references/services.md)                           |
| Mutable state, streams, derived views, or operation ordering          | [State](references/state.md)                                 |
| TypeScript implementation or error handling                           | [TypeScript](references/typescript.md)                       |
| Tests, fixtures, or test review                                       | [Testing](references/testing.md)                             |
| Development hosts, environment setup, CI, or deployment               | [Environments](references/environments.md)                   |
| Adding, integrating, or upgrading external dependencies               | [Dependency management](references/dependency-management.md) |

Read multiple pages when the change crosses boundaries, not the entire handbook for every task. Testing guidance applies to Vitest and Playwright alike.

Examples use simplified TypeScript adapted from real code, not complete implementations. Imports and unrelated setup are omitted; “avoid” shows the counterexample, “prefer” shows the intended shape.

## Apply it to the change at hand

Apply these principles practically. Improve the changed area without turning a small task into a full migration. Do not add wrappers, packages, or tests merely to satisfy a diagram. Garden locally: fix small stale guidance, misleading comments, dead code, and confusing APIs exposed by the work, but leave larger or separate improvements as a scoped follow-up. Keep project commands and agent-specific instructions in `AGENTS.md`, and current architecture and migration progress in the implementation spec. Update that spec as work lands; do not describe planned APIs as available.

Validate changed behavior through the consumer-facing boundary before handoff. Use the running application when it is the relevant boundary, in addition to focused automated checks.
