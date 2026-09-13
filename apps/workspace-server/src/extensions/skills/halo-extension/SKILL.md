---
name: halo-extension
description: Create, edit, run, and verify Halo workspace extensions using the bundled React, oRPC, Tandem, and connected-tool SDK.
---

# Halo extensions

Extensions are standalone web apps under `.halo/extensions/<id>/` in the selected workspace. Halo runs each extension's server and shows its React view in a sandboxed iframe. Each browser owns local UI state; Tandem synchronizes extension-owned records through the extension server.

Work inside the extension directory. Do not recreate the SDK transport, edit generated `dist/` output, or write directly to extension persistence files.

## Read the relevant SDK reference

Read each reference that applies before editing:

- For React views, view props, `useQuery`, routing, assets, or iframe behavior, read [references/view.md](references/view.md).
- For oRPC handlers and the typed browser API, read [references/api.md](references/api.md).
- For schemas, queries, shared data, or transactions, read [references/storage.md](references/storage.md).
- For workspace tools or connected services, read [references/tools.md](references/tools.md).
- For scaffolding, package metadata, builds, hosting, reloads, updates, or removal, read [references/lifecycle.md](references/lifecycle.md).
- Before verifying any extension, read [references/testing.md](references/testing.md).

The references document the SDK bundled with this Halo workspace. For an existing extension, inspect its installed declarations under `node_modules/@get-halo/extension-sdk/` when its dependency version differs. In a development build, `halo extension update <id>` installs the current local SDK and build tools.

## Create and build

With Halo running and a workspace open:

```sh
halo extension new my-extension
cd .halo/extensions/my-extension
```

The command creates the package and installs its dependencies. The host must have `node` and `npm` on `PATH`; Electron's embedded runtime does not provide these commands to the authoring shell.

Adapt the generated package:

- `view.tsx` default-exports the React view.
- `api.ts` default-exports an oRPC router.
- `schema.ts` default-exports the Tandem schema.
- `package.json` owns dependencies, scripts, and optional Halo presentation metadata.

Read `.agents/skills/maui/SKILL.md` before designing or editing the view. Keep `MauiProvider` at the view root. Resolve Maui source references from the extension's `node_modules/maui/` directory.

After editing, run from the extension directory:

```sh
npm run typecheck
npm run build
```

One build compiles the view, API, and schema. Do not compile them separately.

## State ownership

Use React state for state local to one browser, such as navigation, open menus, and unfinished form input. Use Tandem for extension-owned records that should persist or appear in other views. Use API handlers for server work and Halo tools for workspace data or connected services.

Never put provider credentials in extension source, browser code, or shared records. A hosted extension receives Halo's tool connection in its API process.

## Current product boundaries

Halo provides one sidebar entry and one view per extension. The extension owns routing within its view. Declarative sidebar contributions, app-header actions, and named panes are not implemented.

Workspace extensions are trusted. A hosted API can call any tool available to Halo without a manifest permission declaration. Tool availability and account connectivity remain runtime concerns.

## Completion

Exercise the user's main workflow in a real rendered view. Use isolated standalone data for local layout and Tandem behavior; use the Halo-hosted URL for workspace tools and connected services. Verify successful results, visible failures, and browser runtime errors. If a missing account connection or platform dependency prevents the main workflow, report the work as incomplete and name the missing step.
