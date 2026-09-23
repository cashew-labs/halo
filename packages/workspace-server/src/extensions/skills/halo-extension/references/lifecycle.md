# Extension lifecycle and runtime

## Package layout

An extension is a normal private npm package in `.halo/extensions/<id>/`:

```text
<id>/
├── package.json
├── tsconfig.json
├── extension.ts
├── schema.ts
├── view.tsx
└── dist/             generated
```

The directory name is the extension ID. IDs accepted by `halo extension new` begin with a lowercase letter and contain lowercase letters, digits, and hyphens.

## Commands

Use `halo extension --help` for the installed CLI contract.

- `halo extension new <id>` scaffolds the package and runs `npm install`.
- `halo extension list` reports running extensions and their direct view URLs.
- `halo extension reload` rescans the workspace, starts newly discovered built extensions, and stops servers whose extension directories were deleted.
- `halo extension restart <id>` gracefully replaces a running extension process with its current successful build.
- `halo extension update <id>` is available in development builds. It installs locally packed SDK and build-tool packages, typechecks, rebuilds, and restarts the extension.

The CLI runs npm without workspace inheritance, install scripts, audit, or funding prompts.

## Manifest metadata

The extension's `package.json` must contain `name`. Optional Halo fields control presentation:

```json
{
  "name": "calendar-day-view",
  "halo": {
    "displayName": "Calendar",
    "icon": "Calendar"
  }
}
```

- `displayName` appears in the sidebar and pane header. Halo uses the directory ID when it is absent.
- `icon` is an exact, case-sensitive export name from Halo's installed `maui/icons` package.
- The directory ID continues to identify commands, routes, processes, and storage; `name` and `displayName` do not rename those resources.

Search the extension's installed Maui package for an icon name:

```sh
rg -i 'calendar|clock' node_modules/maui/src/icons/index.ts
```

Run `halo extension reload` after editing presentation metadata. The sidebar and pane titles update automatically. Rebuilding or restarting the extension server is not required for metadata alone.

## Build

Run from the extension directory:

```sh
npm run check
npm run build
```

The check validates the TypeScript source. The build bundles the browser view and Node extension definition in parallel. Both must succeed before the new generation is selected. Successful output contains:

- `dist/<build-id>/public/`: the view HTML and bundled assets.
- `dist/<build-id>/server.mjs`: the bundled Hono API and extension lifecycle.
- `dist/current.json`: the selected complete build ID.
- `dist/start.mjs`: a stable launcher that loads the selected server.

Do not edit generated output or create separate build pipelines for the view, API, and schema. Existing server processes keep running the generation they started with; a later build does not hot-reload them. Old successful generations are currently retained.

After pulling changes to Halo itself, run this from anywhere inside the development workspace:

```sh
halo extension update <id>
```

This is the canonical development refresh. It installs the current local SDK and build tools before typechecking, building, and restarting the hosted extension. Reload or reopen the extension pane afterward.

## Runtime routes

The standalone server listens on loopback and owns:

- `/view/` and nested `/view/...` paths for the React app.
- `/view/assets/...` for generated assets.
- `/api/` for the extension Hono app, including SDK WebSocket routes.
- `/sync/` for Tandem synchronization.

Halo starts `dist/start.mjs` with an ephemeral port, a data directory, explicit workspace information, and an IPC channel. It proxies the running extension through `/extensions/<id>/...` for the renderer while preserving the extension's own origin semantics. A `proxyView()` extension may return a private loopback origin from `serve()`; the SDK then forwards `/view/` HTTP and WebSocket traffic to that service.

## SDK modules owned by the build tools

The SDK exports two lower-level modules because the generated build uses them:

- `@get-halo/extension-sdk/client` exports the generated Hono and Tandem connection helper. It derives API and sync paths from the current `/view/` URL.
- `@get-halo/extension-sdk/server` exports the public `defineExtension`, view, lifecycle, and WebSocket types plus lower-level generated runtime functions.

Extension source uses `defineExtension`, `reactView` or `proxyView`, and optionally `upgradeWebSocket`. The generated builder owns connection setup, rendering, listener startup, IPC readiness, and shutdown. Do not call `runExtension` or `serveExtension` directly.

The sync router and tool transport are internal and have no public package subpath.

## Hosting and reload behavior

`halo extension reload` starts extensions that are not already running and pushes the updated extension list to every connected Halo window. It does not rebuild or restart a healthy running process. After a manual `npm run build`, run `halo extension restart <id>` when the user is ready to replace the hosted process. `halo extension update <id>` performs that restart itself. Reload the renderer or reopen the extension pane to load the restarted extension's browser bundle.

Closing Electron leaves the independently hosted workspace server and extensions running. Workspace-server shutdown or workspace replacement stops extension processes gracefully through IPC, with a forced stop after the shutdown timeout.

Hosted records live in `.halo/extension-data/<id>/tandem.json`. Standalone preview records live in the directory passed with `--data-dir`; use `.extension-data` inside the extension for isolated preview state. These tuple files are SDK-owned implementation details. Rebuilding an extension from the earlier runtime leaves its legacy `store.json` untouched and starts a fresh `tandem.json`.

## Remove an extension

Delete `.halo/extensions/<id>/`, then run `halo extension reload`. The sidebar updates automatically. This stops the server and removes its sidebar entry. Stored records are separate under `.halo/extension-data/<id>/`; delete them only when the user explicitly wants that data removed.
