---
name: flow-preview
description: Generates interactive Maui user-flow canvases using a bundled CLI, with linked states and persistent review checkboxes. Use when previewing, comparing, or reviewing a user journey across multiple UI states.
---

# Flow preview

Generate a temporary, self-contained preview using this skill's `scripts/generate.mjs`. Keep this entire skill folder together when moving it. The CLI uses only Node built-ins and works from any project's root, without Halo packages or workspace configuration. The canvas is a development tool, not production application state.

## Derive the story from the real UI

- Read the production component, its consumers, and its state transitions. Map the user's entry point, actions, success, loading, validation, failure, retry, and permission branches that matter to the request. Do not invent screens to fill a grid.
- Adapt the actual production component through props and local fixture callbacks. If it combines server calls with rendering, propose a small presentational extraction; do not maintain a second lookalike UI.
- Keep fixtures and simulated requests in the temporary preview, not production conditionals. Thumbnails mount every state simultaneously: rendering them must not send requests, start real work, or mutate production data. Use deterministic values, not timestamps or random content.
- Use the Maui skill, when available, for UI composition. Keep flow-specific copy and business data in the scenario/adapter, not the generic canvas.

## Generate and serve

From the target project's root, run the script at its actual skill location. For this repository:

```sh
node .agents/skills/flow-preview/scripts/generate.mjs preferences-flow 4180
npm --prefix tmp/preferences-flow install --workspaces=false
```

Arguments are `<lowercase-name> [port]`; the default port is 4180. Names cannot contain paths. Existing previews are never overwritten. The script creates `tmp/<name>/` relative to the current directory, not relative to the skill. It copies the canvas and Vite helper alongside `scenario.tsx`, `main.tsx`, `index.html`, `vite.config.mjs`, and a private `package.json`. Generated previews do not import from this skill or from Halo; the skill can move without breaking them.

Edit **`tmp/<name>/scenario.tsx`**. Install dependencies in that preview only; do not add it to the project's workspace. When importing real application components, align React and Maui versions with that project and retain the Vite helper's deduplication. The helper permits source imports from the project containing `tmp/`.

In an Amp orb, follow the exact supervised command printed by the script:

```sh
amp orb service start flow-preferences-flow --command 'npm --prefix tmp/preferences-flow run dev' --port 4180 --portal
```

Share the returned portal URL; do not share localhost or direct orb host URLs. Outside an orb, use `npm --prefix tmp/preferences-flow run dev`. Stop the service before removing its preview directory. Never start preview servers with `nohup` or a shell background process in an orb.

## Describe states

`FlowScenario` and `FlowNode` are exported from the generated `./FlowCanvas.tsx`:

- Scenario: stable `id`, `title`, `initialState`, and `nodes`; optional `description`, `notice`, `navigationLabel`, and `dimensions`.
- Each node: unique stable `id`, `title`, `action` (incoming user action), optional `parent`, nonnegative `row`, and `render({ mode })`. Keep parents before children; roots omit `parent`. The initial state must exist. Use a separate occurrence ID when a journey revisits a state rather than creating a cycle.
- Columns follow parent depth and pack vertically without empty slots. `row` orders states within their own column; it does not reserve a global lane. Arrows still connect the actual parent and child, even when their vertical positions differ.
- `render` returns the real component adapter. `mode` is `thumbnail` or `preview`; use distinct DOM IDs for each. Keep the visible content equivalent. Optional `note` appears only in the interactive preview, never beneath thumbnail titles.
- `dimensions`: `previewWidth` is the unscaled component width; `nodeWidth`/`nodeHeight` size the thumbnail, and `columnGap`/`rowGap` separate branches. Match height to scaled content so it is not clipped.

The canvas supplies the hierarchical outline, title/checkbox above each thumbnail, pan by scrolling, zoom, animated selection/crossfade, reset, and animated sidebar toggle. Both sidebars use Maui's raised element surface. Outgoing scenes and thumbnails are inert. Reduced motion removes travel while retaining the crossfade.

## Review and verify

Review checkboxes in the outline, canvas, and interactive preview share one per-state value. A check dims only its thumbnail and overlays a green circle with a checkmark. The mark stays fully visible and does not block selecting the state. Browser localStorage stores a fingerprint per scenario/state; reset, theme changes, and reloads preserve it. Changed rendered content or style classes invalidate only the affected state. Fingerprints ignore generated IDs, theme values, and transient animation transforms/opacity. They describe the deterministic thumbnail, not an edited interactive draft. Keep scenario/state IDs stable; a new ID is a new review. Reviews are local to that browser and origin, not shared reviewer storage.

For a new scenario, drive all relevant states and real interactions in its portal. Use the using-agent-browser skill before browser work when available. Check light, dark, narrow layout, keyboard navigation, reset, review synchronization/persistence, and reduced motion. Inspect screenshots, not only DOM assertions. Save only reviewable final screenshots/recordings under `.amp/in/artifacts/`; keep scratch captures in the preview's `tmp/` folder. Do not treat a fixture preview as proof that the real backend operation succeeds.

## Maintain the skill

The bundled `assets/FlowCanvas.tsx` and `assets/previewConfig.mjs` are the sources copied by the CLI. After editing those files or the generator, run from this skill's directory:

```sh
npm install --workspaces=false
npm run typecheck
npm run lint
npm run format:check
npm run test:e2e
```

The browser tests copy the skill to a separate consumer project, generate a notification-preferences flow, remove that skill copy, and exercise the resulting preview. Install Playwright Chromium with `npx playwright install chromium` if needed, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed browser. This skill has no dependency on repository lint or TypeScript configuration. Changes to the skill do not silently update existing generated previews; create a new preview or deliberately refresh its copied canvas/helper while preserving scenario IDs and fixtures.
