---
name: code-review
description: Review pull request and branch diffs for Halo convention violations, unnecessary complexity, and functional correctness. Use for Codex GitHub review, `codex review`, and requested code reviews. Do not use when implementing or refactoring.
---

# Code review

Write one or two short paragraphs as the review body. Say what the change does and whether it is ready. Use plain sentences. Do not write a checklist, scored rubric, or long report.

Leave inline comments only for high-priority issues, on the exact lines that need to change. Skip the comment if the summary already covers it and no line needs an edit. Flag only issues the change introduces. Do not flag pre-existing mismatches that the change does not expand. Leave formatting, lint, and typecheck to CI.

Treat a new handbook violation as P1. Treat a new package, authority, or persistent-state boundary that contradicts the handbook as P0. Treat a correctness failure as P1, and as P0 when the change does not fulfill a requirement or will fail in an expected scenario. Treat a simplicity finding as P1 only when the diff adds an abstraction, file, duplicate path, or barrel that can be removed without changing behavior.

Cite a file path, line, and symbol in each inline comment. For a conventions finding, also cite the handbook page and do not restate the page. For a simplicity finding, say exactly how to simplify and give a concrete alternative.

## Conventions

The handbook at `.agents/skills/conventions/` is the source of truth. Start at `SKILL.md`. Read only the reference pages that apply to the changed files.

## Simplicity

Could this exact goal be achieved with fewer lines of code?
Are there abstractions that don't provide clear value?
Would a more direct approach work just as well?
Are there entire files or functions that could be eliminated?
Is there duplicated logic that could be consolidated?
Are there multiple ways to access the same functionality? There should be exactly one canonical way to access any package, command, or symbol.
Are `index.ts` files being used for re-exports? These create unnecessary indirection. Import directly from source files or direct entry points instead.
Is the same concept implemented in multiple places? Consolidate to a single authoritative implementation.

## Correctness

Does the implementation actually fulfill each requirement?
Will this code work in all expected scenarios?
Are there obvious edge cases that will cause failures?
Do the changes properly integrate with existing code?

Focus only on actual functionality. Do not comment on performance unless it would literally break the system, code style or formatting, potential future features or extensibility, backwards compatibility unless it breaks core functionality, or testing coverage unless tests themselves are the goal.
