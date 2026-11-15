# Update Maui 0.0.72 → 0.0.73

Compared **`main` (72030623, Maui 0.0.72 + local tooltip patch) → `cursor/maui-0-0-73-2897` (c7ff35c5, Maui 0.0.73)**. Halo's own source does not change. The call stack below is source-checked, not a recorded trace. `-` marks removed steps, `+` added steps.

```changes
c7ff35c5
packages/web/package.json
apps/electron/package.json
packages/workspace-server/package.json
packages/extension-tools/src/scaffold.ts
apps/electron/e2e/e2eTest.ts
pnpm-workspace.yaml
patches/@tanishqkancharla__maui@0.0.72.patch
pnpm-lock.yaml
```

## Problem

Halo carried a local pnpm patch on Maui 0.0.72. It made a closing tooltip unmount after a timeout, because the browser skips `transitionend` when a tooltip closes before its first frame, and the tooltip then stayed in the page. Maui 0.0.73 ships that fix upstream (tanishqkancharla/maui#76), so the patch is now duplicate code Halo has to carry forward on every Maui bump.

## Solution

Every Maui pin names 0.0.73, and Halo drops the patch file and its `patchedDependencies` entry. 0.0.73 changes only `Tooltip`, with the same code as the patch, so tooltips behave as before. The Maui skill in the package did not change, so `.agents/skills/maui` and `skills-lock.json` stay as they are.

```mermaid diff
flowchart LR
  web["@get-halo/web"]
  electron["@get-halo/desktop"]
  server["@get-halo/workspace-server"]
  ext["New extensions + E2E fixture"]
- m72["maui 0.0.72 + tooltip patch"]
+ m73["maui 0.0.73"]
- web --> m72
- electron --> m72
- server --> m72
- ext --> m72
+ web --> m73
+ electron --> m73
+ server --> m73
+ ext --> m73
  %% ref node:web [[c7ff35c5:packages/web/package.json#L44]]
  %% ref node:electron [[c7ff35c5:apps/electron/package.json#L44]]
  %% ref node:server [[c7ff35c5:packages/workspace-server/package.json#L58]]
  %% ref node:ext [[c7ff35c5:packages/extension-tools/src/scaffold.ts#L38]] [[c7ff35c5:apps/electron/e2e/e2eTest.ts#L285]]
  %% ref node:m73 [[c7ff35c5:pnpm-workspace.yaml#L83]]
```

## Goals

- Halo, its workspace server, new extensions, and the E2E fixture resolve Maui 0.0.73.
- Halo has no local Maui patch.
- Tooltips still unmount when they close before their first frame.

## The tooltip timeout moves from Halo's patch into Maui

```callstack
 Tooltip  # Maui component behind Halo's sidebar and settings tooltips
 └── useTooltipTransition(state.isOpen)
-    └── useEffect(setTimeout(setRender(false)))  # added by patches/@tanishqkancharla__maui@0.0.72.patch
+    └── useEffect(setTimeout(setRender(false)))  # in maui 0.0.73 src/components/Tooltip.tsx
```

`npm diff` between the two releases touches only `Tooltip.tsx`, its compiled `Tooltip.js`, and `package.json`. The upstream hunk is the patch's hunk, reformatted:

```diff:maui/src/components/Tooltip.tsx
--- a/src/components/Tooltip.tsx
+++ b/src/components/Tooltip.tsx
@@ -162,7 +162,20 @@
 		}
 	}, [isOpen])

+	// Closing before the first frame can skip transitionend entirely.
 	useEffect(() => {
+		if (phase !== "out" || isOpen) return
+		const timeout = setTimeout(
+			() => setRender(false),
+			Math.max(
+				overlayMotion.tooltipExit.durationMs,
+				overlayMotion.reduced.durationMs,
+			),
+		)
+		return () => clearTimeout(timeout)
+	}, [isOpen, phase])
+
+	useEffect(() => {
 		return () => {
 			if (isHeld.current) {
 				isHeld.current = false
```

## Verification

All run with Node 24.22.3 on c7ff35c5:

- `pnpm install`: 0.0.73 passes the supply-chain policy through the new `minimumReleaseAgeExclude` entry, and `node_modules/maui` resolves to 0.0.73.
- `pnpm run check-affected`: 57 of 57 Turbo tasks pass (typecheck, lint, format check, unit tests).
- `pnpm --filter @get-halo/desktop test:e2e:build`, then Playwright for `extensions`, `extensionAuthoring`, `threadView`, and `sidebar`: 27 of 28 pass, including every tooltip assertion in `sidebar`.
  - The PDF attachment test in `threadView` first failed because this VM had no Poppler; it passed after `apt-get install poppler-utils`.
  - `sidebar` › "favorites hide their star at rest…" fails at line 123: the favorite star keeps opacity 1 after the pointer leaves. It fails the same way on `main` with Maui 0.0.72, so this change did not cause it. The test last changed in 87b083eb, after the 0.0.72 update.
