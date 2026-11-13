# Halo review rules

Run `pnpm semvariant context <changed paths>` or `pnpm semvariant context --diff <base>` from the repository root. Read the applicable full rules with `pnpm semvariant show <IDs>` or add `--full` to the context command.

Canonical rules in `tools/semvariant/rules/` are the source of truth. Generated `AGENTS.md` files index their titles by directory. If the diff violates an applicable rule:

- Add a Bug
- Cite the rule ID, source file, and violating symbol or import
- Do not restate the rule in the comment
- Do not invent extra rules
