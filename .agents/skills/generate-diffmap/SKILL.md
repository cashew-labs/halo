---
name: generate-diffmap
description: Create and update living specs and code walkthroughs with diffmap. Use when planning work, implementing from a spec, updating a spec, or explaining code changes.
---

# Living spec

Keep one Markdown file at `specs/<short-kebab-case-name>.md` for the current system, plan, and completed work. Update it as the plan changes and work lands. For an existing PR, reuse its spec; otherwise write the walkthrough under `tmp/`. Check paths and symbols before writing.

**Settle scope first.** Read the relevant code, then ask about unclear choices: design, ownership, scope, and phase boundaries. Give options and your pick. Write once settled; ask again when implementation uncovers a new choice.

## Serve and share

Run from the repo root:

```sh
npx @tanishqkancharla/diffmap list
npx @tanishqkancharla/diffmap serve specs/<name>.md
npx @tanishqkancharla/diffmap share specs/<name>.md
```

Reuse the URL from `list` if the file is already served. Leave the server running and give the user the path and URL. Open the browser only when asked.

**Share only when asked.** Before sharing, commit finished work and point changed references at its commit. A shared gist is a snapshot without git; anyone with its URL can read it, including every file it snapshots. Use the printed `https://diffmap.dev/g/<id>` URL. A PR spec is also at `https://diffmap.dev/<owner>/<repo>/pull/<n>/specs/<name>.md`, pinned to a commit.

## Write top-down

Start with what changes for the person using the product or developer calling the code, CLI, or API. Work back from their entry point to the implementation, both in the overview and each phase.

Include a title, problem overview (who is affected, cost, why now), solution overview with system and boundary diagrams, goals, non-goals, phases, and **References**.

Keep each phase small enough to commit alone. Use plain headings for planned phases, ⏳ for in progress, and ✅ for done. Open with **Today** and **Proposed** from the client's view: concrete behavior, its cost, the change, and why this phase comes here. For internal work, name the client-facing change it prepares. Keep both sections after completion.

Show usage or UI changes first, then explain each layer's logic and data shapes. Alternate short paragraphs with visuals; use a visual when a paragraph needs more than three sentences. Each phase needs a call stack diff, pseudocode for new logic in the repo's main language, focused diagrams, and types for new data shapes. Never end a phase with a task list or checkboxes.

Use diagrams to show how parts fit and call stacks to show function-level data flow: named inputs, assigned results, explicit returns, conditions, retries, and side effects. Link existing symbols; leave planned names unlinked and identify them as pseudocode, not promised public APIs. Follow Orwell's six rules in prose, comments, and labels.

## Look up the rest

- Writing diagrams or call stacks → [authoring guidance](references/authoring.md#diagrams)
- Need a worked phase → [example](references/authoring.md#example-phase)
- Finishing a phase → [completion steps](references/authoring.md#when-a-phase-is-complete), including separate code/spec commits, commit references, and restarting `serve`
- Linking source or choosing fences → [syntax](references/authoring.md#source-references)
