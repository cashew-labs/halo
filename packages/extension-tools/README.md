# Extension tools

Shared development tooling for standalone Halo extensions. An extension installs
`@get-halo/extension-sdk` as a dependency and `@get-halo/extension-tools` as a
dev dependency. Build configuration lives here; the runtime SDK does not depend
on esbuild.

An extension contains three source files:

- `view.tsx`: the default-exported React app, served under `/view/`. Nested URLs
  load the same app, which owns its frontend routing.
- `api.ts`: the default-exported oRPC router, mounted directly under `/api/`.
- `schema.ts`: the named Tandem `schema` and `relations` exports. The SDK owns
  `/sync/`.

```ts
import { scaffoldExtension } from "@get-halo/extension-tools/scaffold";

const result = await scaffoldExtension({
  directory: "/absolute/path/to/my-extension",
  name: "my-extension",
});
if (result instanceof Error) throw result;
```

The equivalent CLI is `npx @get-halo/extension-tools@0.2.0 scaffold my-extension`. Scaffolding
creates a new directory and writes the source, package scripts, dependencies,
TypeScript configuration, and gitignore. Installation is explicit:

```sh
cd my-extension
npm install
npm run typecheck
npm run build
npm start -- --port 3000 --data-dir .extension-data
```

The scaffold installs versioned SDK and tools packages from npm. For local development, the scaffold
API accepts `packages: { sdk: "file:/path/to/sdk.tgz", tools: "file:/path/to/tools.tgz" }`.
The end-to-end tests pack both packages and install them with pnpm in standalone
test projects. pnpm reuses its shared package store across tests. Failed tests
retain source, builds, data, and diagnostics, but discard `node_modules`.

One build compiles the frontend and Node server, including their imported schema
code and real dependencies. Both outputs must succeed before `dist/current.json`
selects the new build. `node dist/start.mjs` starts that complete build without
loading the development tools. Existing processes continue using their original
build. Successful build generations are retained; pruning is not implemented.

The server listens on loopback and serves `/view/`, `/api/`, and `/sync/`.
It owns one `TandemServer` backed by `TandemServerJsonFileStorage`, which
persists data to `<data-dir>/tandem.json`. The tuple file is an SDK-owned
implementation detail and extension code must not read or write it directly.
Rebuilding an extension from the earlier runtime starts a fresh `tandem.json`;
any legacy `store.json` remains untouched and recoverable.
Halo discovers built apps in `<workspace>/.halo/extensions/<id>/` when opening
the workspace. It starts each app with the bundled Node runtime and stores data
in `<workspace>/.halo/extension-data/<id>/`. `extensions.list()` exposes their
running view URLs without starting or rebuilding anything. `extensions.reload()`
rescans the current workspace and starts extensions that are not running yet.
It preserves existing servers and their URLs; it does not rebuild or restart
running extensions. Reloads are serialized with workspace changes and shutdown.
Workspace switching and app shutdown stop the hosted processes.

Halo lists running extensions in its sidebar. Opening an entry displays its
`/view/` app in a sandboxed iframe at `/extensions/<id>`, with a Halo-owned pane
header. The iframe retains its extension origin for API calls and storage.
After adding an extension, call `extensions.reload()`. The sidebar receives the
updated list automatically through `extensions.watch()`.

Named sub-panes, dynamic sidebar contributions, authentication, and workspace
tool access are not connected yet.
JSON persistence is a prototype default, not the final database design.

## Verification

```sh
pnpm --filter @get-halo/extension-tools test
```

`test/fixtures/tasks/` holds the reusable Tasks source as ordinary TypeScript and TSX files. `await loadExtension(sourceDirectory)` is supplied by the fixture. It scaffolds a
package through the public API, writes that source, installs the packed packages,
typechecks, builds, and runs an actual Node server. Playwright tests cover the
starter, nested view URLs and API calls, collaboration between independent
browser contexts, and persistence after restart. No Electron or Halo server runs.
