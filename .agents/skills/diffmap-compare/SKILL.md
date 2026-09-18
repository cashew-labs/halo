---
name: diffmap-compare
description: >-
  Compare two presentations of a requested code diff: untouched upstream Diffmap and the custom tabbed review. Use when the user requests this comparison or invokes $diffmap-compare, not for ordinary code-walkthrough requests.
---

# Compare two review experiences

This is an opt-in orchestration of two code-walkthrough variants for the branch, PR, commit range or working-tree diff the user requests. Ordinary `$code-walkthrough` requests keep their existing single-review workflow.

Create two separately authored documents from the same researched change. Keep the upstream viewer and its skill instructions unchanged. Customize only the experimental viewer and [custom authoring instructions](references/custom.md).

## Prepare

From the Halo repo root, run `pnpm review:sync` (or `python3 .agents/skills/diffmap-compare/scripts/review.py sync`). It prints the two instruction paths and the exact revisions. Python 3, Node 22.19+ (Node 24 recommended), npm and git must be available on PATH. No personal skill installation is needed; all maintained inputs live in `.agents/skills/diffmap-compare/`.

Use the code-walkthrough skill at the printed `upstreamSkill` path, with its referenced material, to research and author the standard document. For the second document, reuse that research and apply the custom authoring instructions below. This comparison skill owns launching both documents; do not run a separate single-viewer launch from the nested walkthrough instructions. Read [references/custom.md](references/custom.md) for the custom document. Research the code once; use the same base/head, source root, real patches and verification evidence in both documents. User instructions about task scope still apply: a request to explain landed code does not authorize new implementation or public sharing.

The upstream checkout lives in `<project>/tmp/diffmap-compare/upstream` at the latest remote `main`. The custom checkout lives beside it in `custom`, reconstructed from the pinned base in `assets/versions.json` plus `assets/custom.patch` (upstream MIT notice in `assets/LICENSE`). Never apply the custom patch or custom authoring rules to upstream. Sync refuses to overwrite local edits.

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

Edit `references/custom.md` for authoring changes. Edit `<project>/tmp/diffmap-compare/custom` for viewer changes, run that checkout's checks and exercise the changed UI. Then run:

```sh
python3 .agents/skills/diffmap-compare/scripts/review.py capture-custom
```

This saves the custom changes into `assets/custom.patch` without touching upstream. Commit the updated patch with the skill; it recreates the customized viewer after temporary checkouts are removed. Keep the custom base pinned until deliberately porting it to another version. `sync` updates upstream independently, so a baseline update cannot silently replace the experiment.
