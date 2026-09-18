---
name: diffmap-compare
description: >-
  Compare two presentations of a requested code diff: the first Diffmap variant and the custom tabbed review. Use when the user requests this comparison or invokes $diffmap-compare, not for ordinary code-walkthrough requests.
---

# Compare two review experiences

This is an opt-in orchestration of two code-walkthrough variants for the branch, PR, commit range or working-tree diff the user requests. Ordinary `$code-walkthrough` requests keep their existing single-review workflow.

Create two separately authored documents from the same researched change. Keep the two viewer implementations separate. Both now include user-requested review improvements: a code-free opening, a continuous overview, plain-language diagrams, and wrapped inline call-stack explanations. Version 1 keeps its table of contents and single source pane; version 2 keeps file tabs on the right. Apply the shared [authoring instructions](references/custom.md) to both documents.

## Prepare

From the Halo repo root, run `pnpm review:sync` (or `python3 .agents/skills/diffmap-compare/scripts/review.py sync`). It prints the two instruction paths and the exact revisions. Python 3, Node 22.19+ (Node 24 recommended), npm and git must be available on PATH. No personal skill installation is needed; all maintained inputs live in `.agents/skills/diffmap-compare/`.

Use the code-walkthrough skill at the printed `upstreamSkill` path for research and source-reference syntax. The shared authoring instructions below take precedence for page structure in both variants; omit boilerplate goals/non-goals and keep implementation steps expandable. Reuse the same source research for the second document. This comparison skill owns launching both documents; do not run a separate single-viewer launch from the nested walkthrough instructions. Read [references/custom.md](references/custom.md) for the custom document. Research the code once; use the same base/head, source root, real patches and verification evidence in both documents. User instructions about task scope still apply: a request to explain landed code does not authorize new implementation or public sharing.

Both checkouts live under `<project>/tmp/diffmap-compare/`. Version 1 (`upstream`) is reconstructed from `upstreamBase` plus `assets/upstream.patch`; version 2 (`custom`) uses `customBase` plus `assets/custom.patch`. The name `upstream` is retained for CLI compatibility; this is now a customized first variant, not an untouched baseline. Keep both pinned bases and patches separate. Sync refuses to overwrite unsaved changes. The MIT notice is in `assets/LICENSE`.

## Author both versions

Write the standard document according to the upstream skill's current structure and location rules. Write the custom counterpart under `tmp/code-walkthrough-<topic>/custom.md`. Use distinct files: upstream does not support the custom `explain:` extensions.

Keep facts equivalent while allowing the presentation to differ. Do not turn this into a comparison of different PRs or different test results. Label shortened examples and simulated tests. Preserve source patches verbatim. If showing an older reviewed revision, serve both against a checkout of that revision so source links and types match.

## Start both

```sh
pnpm review:compare <upstream.md> <custom.md> --root <source-workspace>
```

Run from the project root. For a separate runtime workspace, use `python3 .agents/skills/diffmap-compare/scripts/review.py --workspace <project> serve ...`. The defaults are upstream at **http://127.0.0.1:4178** and custom at **http://127.0.0.1:4179**. Both ports can be overridden with `--upstream-port` and `--custom-port`.

The launcher starts detached local processes, waits for readiness and prints both URLs. Matching existing servers are reused. A new review replaces only the launcher's own recorded servers. It refuses to stop an unrelated occupant of either port. Runtime revisions, logs and process state live in the project's `tmp/diffmap-compare/` directory. Use `status` to inspect them and `stop` to stop owned servers.

Check that each document renders, its source references work, and the two URLs show the intended different experiences. Return **both labeled links**, not just the preferred version. Do not publish either document or create a public gist unless asked.

## Improve the experiment

Edit `references/custom.md` for authoring changes. Edit either runtime checkout, run its checks and exercise the changed UI. Save each independently:

```sh
python3 .agents/skills/diffmap-compare/scripts/review.py capture-upstream
python3 .agents/skills/diffmap-compare/scripts/review.py capture-custom
```

These save the two independent patches without copying one variant into the other. Commit the changed assets and instructions; sync then recreates the same review experience. Keep the bases pinned until deliberately updating a variant and revalidating it.
