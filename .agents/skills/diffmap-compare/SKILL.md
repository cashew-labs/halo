---
name: diffmap-compare
description: >-
  Compare two presentations of a requested code diff: the first Diffmap variant and the custom tabbed review. Use when the user requests this comparison or invokes $diffmap-compare, not for ordinary code-walkthrough requests.
---

# Compare two review experiences

This is an opt-in orchestration of two code-walkthrough variants for the branch, PR, commit range or working-tree diff the user requests. Ordinary `$code-walkthrough` requests keep their existing single-review workflow.

Create two separately authored documents from the same researched change. Keep the viewer implementations and authoring rules separate. The 4178 reference version is the comparison baseline. The 4179 custom version follows [custom authoring instructions](references/custom.md): a code-free overview, a compact table of contents, contextual diagrams and expandable call stacks, and file tabs on the right without hiding the overview. Do not include a “Files in this change” section or other file inventory.

For custom-only feedback, change only the custom viewer, custom document, and custom guidance. Leave the reference viewer, its document, its patch, and its process unchanged. Do not apply custom preferences to upstream unless the user explicitly asks to change both.

## Prepare

From the Halo repo root, run `pnpm review:sync` (or `python3 .agents/skills/diffmap-compare/scripts/review.py sync`). It prints the two instruction paths and the exact revisions. Python 3, Node 22.19+ (Node 24 recommended), npm and git must be available on PATH. No personal skill installation is needed; all maintained inputs live in `.agents/skills/diffmap-compare/`.

Use the code-walkthrough skill at the printed `upstreamSkill` path for the reference document. Read [references/custom.md](references/custom.md) before authoring the custom document; its reading experience takes precedence over the upstream template only for that custom document. Reuse source research while keeping the presentations independent. This comparison skill owns launching both documents; do not launch an additional single viewer from the nested walkthrough instructions. Use the same base/head, source root, real patches, and verification evidence in both documents. A request to explain code does not authorize implementation or public sharing.

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

Edit `references/custom.md` for custom authoring preferences and `<project>/tmp/diffmap-compare/custom` for custom viewer behavior. Run that checkout's checks and verify the UI, then save only the custom patch:

```sh
python3 .agents/skills/diffmap-compare/scripts/review.py capture-custom
```

Keep the patch and authoring instructions together so future comparisons recreate the same experience. Keep the pinned custom base until deliberately updating it and revalidating. The launcher reuses an unchanged 4178 server when serving the revised custom document.

`capture-upstream` is reserved for an explicit request to change the reference version. Do not run it or update `assets/upstream.patch` as part of a custom-only iteration.
