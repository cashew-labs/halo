---
name: semvariant
description: Retrieve and maintain Halo's directory-scoped repository rules with the semvariant CLI. Use when applying, editing, consolidating, or retiring repository guidance.
---

# Semvariant

For the files you will change, run `pnpm semvariant context <paths>` from the repository root. Use `--staged` or `--diff <rev>` instead of explicit paths when reviewing a diff. Add `--full` to retrieve bodies, or use `pnpm semvariant show <IDs>` to read selected rules before applying them. `pnpm semvariant search <terms>` searches all rule titles and bodies; multiple terms match any term.

When changing guidance, include `tools/semvariant` in the context selection so you read the rule-authoring guidance. Search for an existing owner before adding a new rule. Edit the canonical `tools/semvariant/rules/RNNNN.md` files, then run `pnpm semvariant generate` and `pnpm semvariant check`. Generated `AGENTS.md` files contain titles and retrieval instructions; edit their sources rather than the projections.

If retrieval reports drift, inspect the reported files and run generation. An authored `AGENTS.md` collision requires deliberately migrating its guidance before replacing it; the generator will not overwrite it.
