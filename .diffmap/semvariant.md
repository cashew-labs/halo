# Semvariant repository guidance

Semvariant manages Halo’s directory-scoped repository guidance. The CLI lives in `tools/semvariant/` and runs directly with the repository's Node version. No service or product runtime is involved.

## Sources and projections

The 64 initial `tools/semvariant/rules/RNNNN.md` files contain the migrated root guidance, conventions handbook, workspace-server Turso guidance, and rule-authoring guidance. Each file has only a `guides` list in its frontmatter, one H1 claim, and a freeform Markdown body. IDs are stable references, not priorities.

`guides` selects existing repository directories. Generation writes a title index to each directory's `AGENTS.md`. A rule applies there and below, together with ancestor rules. General code guidance is repository-wide, including root tools and agent scripts; UI, Turso, Entire maintenance, and rule-authoring guidance has narrower scopes. The generated prelude explains retrieval, inheritance, and editing.

The conventions skill and reference pages are removed. The semvariant skill supplies the retrieval and editing workflow. Code-review and Cursor review instructions retrieve full rules and cite their IDs. Entire's generated `.entire/agent-guide.md` remains separate; R0018 directs agents to read it.

## CLI

Run these from the repository root:

```sh
pnpm semvariant context packages/workspace-server/src/WorkspaceServer.ts
pnpm semvariant context --staged --full
pnpm semvariant context --diff main
pnpm semvariant search fixture lifecycle
pnpm semvariant show R0030 R0043
pnpm semvariant generate
pnpm semvariant check
```

`context` unions rules from each selected path's ancestors and deduplicates them. Selecting a directory does not select all its descendants. The default output contains titles; `--full` adds complete records. Git selection includes deleted paths and both sides of renames. Untracked files require explicit paths or staging. `search` matches any supplied substring, case-insensitively; `show` accepts multiple case-insensitive IDs.

Generation repairs missing or changed projections, removes stale generator-owned guides, and refuses to overwrite authored guides. Guide paths must stay inside the repository, exist, and contain no symlink components or excluded directories (`.git`, `node_modules`, `data`). The generator never follows symlinks while discovering stale guides. Authored guides outside the projection remain untouched.

All retrieval commands require valid rule records and current projections. `generate` is the repair command. `check` checks structure and drift; agents judge semantic compliance using complete rule bodies. Consolidation is manual: search, edit or merge the owning rules, remove retired sources, and regenerate.

## Verification

`pnpm check-affected` always runs `semvariant:check` before Turbo's affected checks, so guidance-only changes are validated. This checks record integrity, projection drift, and the CLI's types, lint, and formatting. Generated `AGENTS.md` files are excluded from formatting because the generator owns their bytes.

The migration was exercised with temporary filesystem, Git, and native CLI tests under `tools/semvariant/.tmp-tests/`, following Halo's temp-test policy. No new durable test suite was added.
