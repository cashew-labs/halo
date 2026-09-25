# Extension SDK

Runtime libraries shared by standalone Halo extensions:

- `/schema`: Tandem schema and relation builders for `schema.ts`.
- `/view`: typed `ExtensionViewProps` and the `useQuery` React hook.
- `/client`: generated Hono and Tandem browser connection setup.
- `/server`: Hono extension definitions, WebSockets, lifecycle, views, and the generated runtime.

`extension.ts` defines the Hono API, schema, relations, and view kind.
`view.tsx` receives `{ api, storage }`. `api` calls the extension's Hono app at
`/api/`; `storage` is its Tandem client, connected through `/sync/`. Pass a stable
query object to `useQuery(storage, query)` and use Tandem transactions for edits.
The schema module named-exports `schema` and `relations`; the generated browser
entry passes both definitions to the client so relational
`with` queries remain typed through `ExtensionViewProps` and `useQuery`.
Each browser owns its client and local navigation; the server owns persistent
shared data through one `TandemServer` backed by
`TandemServerJsonFileStorage`. The adapter writes `<data-dir>/tandem.json` as an
SDK-owned implementation detail; extension code must not read or write it.
Rebuilt extensions do not parse or replace a legacy `store.json`, so the old
file remains recoverable while the new runtime starts a fresh store. The SDK
does not import Halo or require Electron.

An extension may declare SDK-managed Hono WebSocket routes under `/api`. A
`proxyView()` extension may start a private loopback service from `serve()` and
return its origin; the SDK forwards `/view/` HTTP and WebSocket traffic and calls
the returned `close()` during shutdown.

When launched with a Node IPC channel, the server reports its ready URL and
accepts a `shutdown` message. It closes HTTP, WebSockets, lifecycle resources,
and Tandem before disconnecting.
Losing the parent connection also shuts it down. Standalone CLI processes
continue to use SIGINT or SIGTERM for shutdown.

The generated application bundles the SDK and its dependencies. React and
ReactDOM are normal peer dependencies within each extension's dependency tree;
they are not injected from Halo or shared as live objects across extensions.

Scaffolding and esbuild configuration live in the separate development package,
[`@get-halo/extension-tools`](https://www.npmjs.com/package/@get-halo/extension-tools). Both packages use the
repository's TypeScript version to emit their runtime JavaScript and declarations.

When Halo hosts the extension, Hono handlers receive `context.env.tools`, and
`serve()` receives `tools`. Calls use
Halo's connected services. Workspace extensions are trusted and can call any
available tool. Call tools from `extension.ts`, keep credentials out of the
view, and import `ExtensionToolResult` from `/server` to describe a tool result.

A standalone server still serves its API and storage, but calls to Halo tools
return `halo_not_connected`. Verify connected-service behavior through the
Halo-hosted view. The development app installs local package builds when creating extensions.
After Halo's source changes, use `halo extension update <id>` to install updated
local packages, check, rebuild, and restart an existing extension. Reload or
reopen its pane afterward. SDK 0.3 is a source-format change from the prior
`api.ts`/oRPC SDK; already-built older extensions retain runtime compatibility.
