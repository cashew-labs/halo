# Remove Entire from orb setup and agent workflows

## Outcome

Entire is no longer part of the repository's orb lifecycle or agent workflows. `.agents/setup` installs the application toolchain and browser dependencies; `.agents/resume` restores GCP credentials. Neither calls Entire. All agent capture hooks/plugins, custom patches, diagnostic fixtures, tracked Entire settings, and generated Graph/Brain guidance are removed. Codex's unrelated Plannotator hook remains.

```ts
// Orb lifecycle after removal (pseudocode).
setup.installNodeAndPnpm();
setup.installWorkspaceDependenciesAndBrowser();
resume.restoreGcpCredentials();
// No Entire binaries, capture hooks, indexing, or memory worker.
```

The user chose full removal after investigating setup latency and unattended authentication. The earlier upgrade proposal was abandoned; this change does not upgrade Entire or migrate its stores.

## Ownership and boundaries

- [[.agents/setup]] removes the Entire CLI, Amp adapter, Brain, Graph, and their Go toolchain installation. It retains step timings, skips an already-installed pinned pnpm, and checks Playwright system dependencies before running apt.
- [[.agents/resume]] retains ADC handling and no longer restores Entire login files, repairs hooks, runs diagnostics, or starts a worker.
- [[.codex/hooks.json]] retains the original non-Entire hook. Other Entire-only agent hook/plugin files are removed.
- Semvariant's Entire-specific rules and generated projections are retired. [[tools/semvariant/rules/R0024.md]] retains approval requirements for review gates and access; [[tools/semvariant/rules/R0025.md]] retains application development setup guidance.
- [[.gitignore]] ignores `.entire/` as a whole so historical private data remains untracked after its nested ignore file is removed.

No existing checkpoint refs, memories, transcripts, credentials, or hosted data are deleted. No GitHub App installation, hosted agent, remote repository, review gate, or shared secret is changed.

## Validation

With all five Entire executables absent from PATH, setup passed twice in 4.16s and 4.64s; resume passed in 0.043s and 0.048s. The second resume used an invalid `ENTIRE_LOGIN` value to confirm the retired credential path is not read. These are warm runs, not a measured cold setup.

Shell syntax, Semvariant generation/check, and diff checks passed. An independent comparison against the original Codex configuration confirmed the non-Entire hook is unchanged. The local repository was disabled before removing tracked settings; retained data is ignored, all 88 checkpoint refs remain, and no orb service is running. The worker was stopped, Brain/Graph plugins and Entire executable links were removed, and Amp plugins were reloaded without Entire.
