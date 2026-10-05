# Dependency management

## Research before adding integration ceremony

Research established behavior before adding surprising ceremony around an external dependency. If straightforward code appears to need guards, wrappers, assertions, retries, or compatibility logic, inspect the dependency's source, official documentation, and relevant GitHub issues before keeping that design.

For common integrations, look for projects that combine the same libraries and compare their ownership and lifecycle boundaries. Useful references include:

- [Craft Agents](https://github.com/craft-ai-agents/craft-agents-oss) for Electron, Pi, Vite, and esbuild.
- [bb](https://github.com/get-bb/bb) for an Electron, Vite, and React agent IDE with a plugin system.
- [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) for another agent application architecture.

Use these projects as evidence, not authority. Keep Halo's own ownership, error-handling, and monorepo conventions when their designs differ.

## Upgrade with the dependency's design

Before upgrading a dependency, read its official changelog or release notes for every version crossed by the upgrade. When those notes are incomplete, inspect the official tag comparison, migration guide, API documentation, or source. Use that evidence to identify breaking changes, changed contracts, and new APIs; do not treat a newly noticed API as upgrade-specific unless the target version actually introduced it.

Search the affected code for compatibility adapters, feature detection, manual normalization, duplicated state, loose types, and comments that explain limits of the old version. Prefer the dependency's new supported path when it preserves the repository's ownership and error-handling conventions.

Apply minor cleanup as part of the upgrade when it is local, behavior-preserving, and directly replaces an old-version workaround. Remove the obsolete path and test the supported behavior rather than retaining both implementations.

Ask the user before expanding the upgrade into a major refactor. Treat a cleanup as major when it changes public APIs, package or service ownership, persistence, lifecycle boundaries, or the integration architecture. Explain the opportunity and its relation to the upgrade so the user can choose whether to include it.

Keep related dependency versions coherent, update the lockfile through the repository's package manager, and run the checks that exercise the upgraded integration. Report unrelated peer or compatibility warnings separately instead of broadening the upgrade without evidence.
