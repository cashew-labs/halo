---
name: codex-review
description: Review pull request and branch diffs against the Halo conventions handbook. Use for Codex GitHub review, `codex review`, and requested code reviews. Do not use when implementing or refactoring.
---

# Codex review

Review the current diff against the conventions handbook. The handbook at `.agents/skills/conventions/` is the source of truth. Start at `SKILL.md`. Read only the reference pages that apply to the changed files.

If the diff introduces a violation of those pages:

- Treat it as P1 so GitHub review posts it. Treat a new package, authority, or persistent-state boundary that contradicts the handbook as P0.
- Cite the page path and the violating symbol or import.
- Do not restate the handbook in the comment.
- Do not invent extra rules.
- Do not flag pre-existing mismatches that the change does not expand. Those are tracked in `specs/repo-conventions-migration.md`.
- Leave formatting, lint, and typecheck to CI.

Apply the change in front of you. Do not require a repo-wide conventions migration.
