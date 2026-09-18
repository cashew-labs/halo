---
name: code-walkthrough
description: Explain code changes with paired upstream Diffmap and custom tabbed reviews, returning both local URLs for comparison.
---

# Compare code walkthroughs

Use the repository's [diffmap-compare skill](../diffmap-compare/SKILL.md) for code reviews and walkthroughs. Follow its paired-document workflow; the launcher, custom instructions and viewer patch all live in this repository.

This is a dispatcher, not a modified copy of upstream's authoring instructions. The comparison skill fetches the latest original instructions from `https://github.com/tanishqkancharla/diffmap` into an untouched checkout, and keeps the custom instructions and viewer patch separately.

Research the requested change once, write the upstream and custom documents against the same refs, then launch both. Return the upstream URL on port 4178 and the custom URL on port 4179, or the actual overridden ports printed by the launcher. Keep the source root aligned with the reviewed revision. Do not publish a gist unless asked.
