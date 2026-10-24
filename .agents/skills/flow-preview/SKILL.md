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
- Render the production UI without added surface labels, headers, instruction panels, or simulation-disclaimer footers. Put context in the node's `note`. Show only the local simulation buttons needed for the current state, with explicit action labels such as “Simulate grant access”; do not add a “Preview controls” header.
- Keep map thumbnails unframed at rest. On hover, show one background around the whole node: title, review checkbox, and thumbnail, including the gaps between them. Preserve the production component's own surfaces. Only the selected interactive preview gets a gallery-style dotted panel, with the UI centered inside it. Use plain state titles without number prefixes; the graph and outline already communicate order.

## Generate and serve

From the target project's root, run the script at its actual skill location. For this repository:

```sh
node .agents/skills/flow-preview/scripts/generate.mjs preferences-flow 4180
npm --prefix tmp/preferences-flow install --workspaces=false
```

Arguments are `<lowercase-name> [port]`; the default port is 4180. Names cannot contain paths. Existing previews are never overwritten. The script creates `tmp/<name>/` relative to the current directory, not relative to the skill. It copies the canvas and Vite helper alongside `scenario.tsx`, `main.tsx`, `index.html`, `vite.config.mjs`, and a private `package.json`. Generated previews do not import from this skill or from Halo; the skill can move without breaking them.

Edit **`tmp/<name>/scenario.tsx`**. Install dependencies in that preview only; do not add it to the project's workspace. When importing real application components, align React and Maui versions with that project and retain the Vite helper's deduplication. In `vite.config.mjs`, pass only the required source directories as `sourceRoots` to `previewConfig` (paths are relative to the preview directory, for example `sourceRoots: ["../../packages/web/src"]`). The default allowlist covers the preview directory only; never allow the project root or runtime workspace. Credential files, `.git`, `.halo`, and `.amp` remain denied even inside an allowed source directory. Verify these boundaries through HTTP before sharing a portal.

In an Amp orb, follow the exact supervised command printed by the script:

```sh
amp orb service start flow-preferences-flow --command 'npm --prefix tmp/preferences-flow run dev' --port 4180 --portal
```

Share the returned portal URL; do not share localhost or direct orb host URLs. Outside an orb, use `npm --prefix tmp/preferences-flow run dev`. Stop the service before removing its preview directory. Never start preview servers with `nohup` or a shell background process in an orb.

## Describe states

`FlowScenario` and `FlowNode` are exported from the generated `./FlowCanvas.tsx`:

- Scenario: stable `id`, `title`, `initialState`, and `nodes`; optional `description`, `navigationLabel`, and `dimensions`.
- Each node: unique stable `id`, `title`, `action` (incoming user action), optional `parent`, nonnegative `row`, and `render({ mode })`. Keep parents before children; roots omit `parent`. The initial state must exist. Use a separate occurrence ID when a journey revisits a state rather than creating a cycle.
- Columns follow parent depth and pack vertically without empty slots. `row` orders states within their own column; it does not reserve a global lane. Arrows still connect the actual parent and child, even when their vertical positions differ.
- `render` returns the real component adapter. `mode` is `thumbnail` or `preview`; use distinct DOM IDs for each. Keep the visible content equivalent. Optional `note` appears only in the interactive preview, never beneath thumbnail titles.
- `dimensions`: `previewWidth` is the default unscaled component width; `nodeWidth` is the thumbnail width and `nodeHeight` its maximum height. Each node can set `maxWidth` and `maxHeight` in unscaled pixels. Use the production component's existing width cap so its content fills the thumbnail instead of shrinking inside unused space. The interactive UI fills available width up to that cap, grows with its content, and scrolls at the smaller of its height cap (by default the unscaled thumbnail height) and the available pane height. Keep the title and navigation outside that scroll area. Shorter previews shrink to their rendered height, including their hit targets and arrow anchors. Title rows use their natural height, not a fixed-height heading slot. `columnGap`/`rowGap` separate branches. Set the maximum height large enough that relevant content is visible.

The canvas supplies the hierarchical outline, title/checkbox above each thumbnail, pan by scrolling, zoom, animated selection/crossfade, reset, and animated sidebar toggle. Keep preview chrome to the state title, review checkbox, reset, and navigation actions; do not repeat “Interactive preview” or “Follow this flow” headings. Both sidebars use Maui's raised element surface. Thumbnails have no enclosing card surface or border at rest. A single native CSS `:hover` on the whole node supplies an instant Maui hover background, without transitions, geometry changes, or title-color changes. The header, checkbox, thumbnail, and their gaps stay inside that continuous hover area. Keep the selection button transparent on native `:hover`, not only React Aria's delayed `data-hovered`, to prevent a first-frame fill flashing over the UI. Selection makes the title accent-colored and semibold. Clicking the title or thumbnail selects the state; the checkbox only changes its review. Hovering does not select or reset a state. Outgoing scenes and thumbnail contents are inert; use the interactive preview to exercise their controls. Reduced motion removes travel while retaining the crossfade.

Center the selected UI in a panel matching Maui gallery's `Panel` recipe: gray-1 surface, gray-alpha-3 dots at 12px intervals, outline border, and extra-large radius. Use the same dotted background recipe for the map canvas. Use an even, compact inset on all four sides and no minimum panel height; cap the panel itself at the UI width plus its inset and border rather than leaving wider side gutters. The padded panel owns scrolling, not a tight wrapper around the UI: preserve the production component's shadow instead of clipping it into corner marks. Give thumbnails a small overflow clip margin for shadows while still bounding tall content. Preserve padding owned by the production UI. This is gallery styling, not a `Panel` package import. Keep Previous state and forward actions outside that panel, right-aligned with the same default button styling. Do not add a disclaimer footer. Both sidebar boundaries support dragging and keyboard resizing; widths persist per scenario in browser localStorage. The outline selection background wraps the whole row, including its review checkbox; clicking that checkbox still only changes the review. Clamp sidebars to leave space for the map, and hide resize handles in the stacked narrow layout without replacing the saved desktop widths.

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
