# Extension SDK

Runtime libraries shared by standalone Halo extensions:

- `/api`: oRPC procedure builders and TypeBox schemas for `api.ts`.
- `/schema`: Tandem schema builders for `schema.ts`.
- `/view`: typed `ExtensionViewProps` and the `useQuery` React hook.
- `/client`: browser API and Tandem connection setup.
- `/server`: the standalone HTTP server and command-line startup.

`view.tsx` receives `{ api, storage }`. `api` calls the extension's router at
`/api/`; `storage` is its Tandem client, connected through `/sync/`. Pass a stable
query object to `useQuery(storage, query)` and use Tandem transactions for edits.
Each browser owns its client and local navigation; the server owns persistent
shared data. The SDK does not import Halo or require Electron.

When launched with a Node IPC channel, the server reports its ready URL and
accepts a `shutdown` message. It closes HTTP and Tandem before disconnecting.
Losing the parent connection also shuts it down. Standalone CLI processes
continue to use SIGINT or SIGTERM for shutdown.

The generated application bundles the SDK and its dependencies. React and
ReactDOM are normal peer dependencies within each extension's dependency tree;
they are not injected from Halo or shared as live objects across extensions.

Scaffolding and esbuild configuration live in the separate development package,
[`@get-halo/extension-tools`](https://www.npmjs.com/package/@get-halo/extension-tools). Both packages use the
repository's TypeScript version to emit their runtime JavaScript and declarations.

When Halo hosts the extension, API handlers receive `context.tools`. Calls use
Halo's connected services. Workspace extensions are trusted and can call any
available tool. Call tools from `api.ts`, keep credentials out of the view, and
import `ExtensionToolResult` from `/api` to describe a tool's result.

A standalone server still serves its API and storage, but calls to Halo tools
return `halo_not_connected`. Verify connected-service behavior through the
Halo-hosted view. The development app installs local package builds when creating extensions.
Use `halo extension update <id>` to install updated local packages and rebuild an
existing extension, then restart the workspace server. Published SDK 0.1.0 does
not include tool support.
