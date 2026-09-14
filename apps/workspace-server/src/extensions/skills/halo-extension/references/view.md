# View SDK

`view.tsx` default-exports a React component. The build entry connects the extension, then renders the component with `{ api, storage }`. A view that does not need either prop may ignore them.

## Exports

`@get-halo/extension-sdk/view` exports:

- `ExtensionViewProps<Router, Schema>`: the inferred `api` client and Tandem `storage` props.
- `useQuery(storage, query)`: a React hook that returns a typed, reactive query result.

## Type the injected props

```tsx
import {
  useQuery,
  type ExtensionViewProps,
} from "@get-halo/extension-sdk/view";
import type router from "./api.js";
import type schema from "./schema.js";

const tasksQuery = {
  collection: "tasks",
  orderBy: { label: "asc" },
} as const;

export default function View({
  api,
  storage,
}: ExtensionViewProps<typeof router, typeof schema>) {
  const tasks = useQuery(storage, tasksQuery);
  // ...
}
```

Import the router and schema with `import type`. The build already includes their runtime entrypoints where needed.

## `useQuery`

`useQuery` reads the initial result synchronously, subscribes after render, and updates when matching data changes. It destroys the old subscription when `storage` or the query object changes and when the component unmounts.

Keep the query object stable. Put constant queries at module scope. Memoize a dynamic query:

```tsx
const query = useMemo(
  () => ({ collection: "tasks", where: { done }, limit: 20 }) as const,
  [done],
);
const tasks = useQuery(storage, query);
```

The supported query and transaction contracts are documented in [storage.md](storage.md).

## UI and local state

Read `.agents/skills/maui/SKILL.md` before designing the UI. Each extension installs and bundles its own React, ReactDOM, Maui, and other frontend dependencies; Halo does not inject live package instances into the iframe.

Keep `MauiProvider` at the view root. Use accessible roles and labels so the view works for users and can be exercised through Halo's browser tools.

Use React state for navigation, selection, open controls, and unfinished form data that belongs to one browser. Use Tandem only when state should persist or synchronize with another view.

Catch API and storage failures and render an alert or another clear failure state. Do not clear user input after a failed write.

## URLs and routing

The view is served at `/view/`. Any nested `/view/...` URL serves the same HTML entry, so the view may implement client-side routing.

The generated document sets its base URL to the current `/view/` prefix. Relative bundled assets therefore work both on the standalone server and through Halo's `/extensions/<id>/view/` proxy. Use the browser URL or a router based on `location.pathname`; do not assume the extension is mounted at the origin root.

API and sync clients derive their paths from the current `/view/` location. Do not hard-code standalone ports or Halo proxy paths.

## Iframe boundary

Halo renders the extension in a separate-origin iframe with scripts, same-origin access within the extension, and forms enabled. The iframe does not receive Halo renderer globals or DOM access to the parent app. Communicate with Halo through the extension API and tool bridge, not `window.parent` or Electron APIs.

Halo owns the pane header and available content area. The view should fill its container, handle narrow widths, and own any navigation below that header.
