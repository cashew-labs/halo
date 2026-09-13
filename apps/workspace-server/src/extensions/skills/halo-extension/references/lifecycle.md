# Extension lifecycle and runtime

## Package layout

An extension is a normal private npm package in `.halo/extensions/<id>/`:

```text
<id>/
├── package.json
├── tsconfig.json
├── api.ts
├── schema.ts
├── view.tsx
└── dist/             generated
```

The directory name is the extension ID. IDs accepted by `halo extension new` begin with a lowercase letter and contain lowercase letters, digits, and hyphens.

## Commands

Use `halo extension --help` for the installed CLI contract.

- `halo extension new <id>` scaffolds the package and runs `npm install`.
- `halo extension reload` rescans the workspace, starts newly discovered built extensions, and stops servers whose extension directories were deleted.
- `halo extension update <id>` is available in development builds. It installs locally packed SDK and build-tool packages, typechecks, and rebuilds the extension.

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

A renderer reload picks up presentation metadata from a running extension. Rebuilding or restarting the extension server is not required for metadata alone.

## Build

Run from the extension directory:

```sh
npm run typecheck
npm run build
```

The build bundles the browser view and Node API in parallel. Both must succeed before the new generation is selected. Successful output contains:

- `dist/<build-id>/public/`: the view HTML and bundled assets.
- `dist/<build-id>/server.mjs`: the bundled API server.
- `dist/current.json`: the selected complete build ID.
- `dist/start.mjs`: a stable launcher that loads the selected server.

Do not edit generated output or create separate build pipelines for the view, API, and schema. Existing server processes keep running the generation they started with; a later build does not hot-reload them. Old successful generations are currently retained.

## Runtime routes

The standalone server listens on loopback and owns:

- `/view/` and nested `/view/...` paths for the React app.
- `/view/assets/...` for generated assets.
- `/api/` for the extension router.
- `/sync/` for Tandem synchronization.

Halo starts `dist/start.mjs` with an ephemeral port, a data directory, and an IPC channel. It proxies the running extension through `/extensions/<id>/...` for the renderer while preserving the extension's own origin semantics.

## SDK modules owned by the build tools

The SDK exports two lower-level modules because the generated build uses them:

- `@get-halo/extension-sdk/client` exports `connectExtension(schema)`. It derives API and sync paths from the current `/view/` URL, connects Tandem, and returns `{ api, storage }` or an `ExtensionConnectionError`.
- `@get-halo/extension-sdk/server` exports `serveExtension(args)` and `runExtension(args)`. `serveExtension` starts a loopback HTTP server and returns `{ url, close }` or an `ExtensionServerError`. `runExtension` parses `--port` and `--data-dir`, reports readiness over IPC, and handles process shutdown.

Normal extensions should not call these exports. The generated builder owns connection setup, rendering, server startup, IPC readiness, and shutdown. Inspect them only when changing the SDK/build system or diagnosing that boundary.

The sync router and tool transport are internal and have no public package subpath.

## Hosting and reload behavior

`halo extension reload` starts extensions that are not already running. It does not rebuild or restart a healthy running process. After rebuilding an existing hosted extension, verify the new build in a standalone preview, then restart the workspace server when the user is ready to replace the hosted extension process. Reloading the renderer or restarting only Electron does not replace it. There is currently no per-extension restart command.

Closing Electron leaves the independently hosted workspace server and extensions running. Workspace-server shutdown or workspace replacement stops extension processes gracefully through IPC, with a forced stop after the shutdown timeout.

Hosted records live in `.halo/extension-data/<id>/store.json`. Standalone preview records live in the directory passed with `--data-dir`; use `.extension-data` inside the extension for isolated preview state.

## Remove an extension

Delete `.halo/extensions/<id>/`, then run `halo extension reload` and reload the renderer. This stops the server and removes its sidebar entry. Stored records are separate under `.halo/extension-data/<id>/`; delete them only when the user explicitly wants that data removed.
