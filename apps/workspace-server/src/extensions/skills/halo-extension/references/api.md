# API SDK

`api.ts` default-exports an oRPC router. The SDK mounts that router at `/api/`, and the browser receives a typed client with the same nested shape.

## Exports

`@get-halo/extension-sdk/api` exports:

- `os`: an oRPC builder whose default context is `ExtensionContext`.
- `type`: oRPC's type-only contract helper for typed inputs and outputs.
- `Type`: TypeBox's runtime schema builder.
- `ExtensionContext`: `{ tools: ExtensionTools }`.
- `ExtensionTools`: the callable, path-based Halo tool client type.
- `ExtensionToolResult<Data>`: the success or failure result returned by a Halo tool.

The tool-specific exports are documented in [tools.md](tools.md).

## Define a router

The simplest router is an object of handlers:

```ts
import { os } from "@get-halo/extension-sdk/api";

export default {
  greeting: os.handler(() => "Hello from Halo"),
  clock: {
    now: os.handler(() => ({ timestamp: Date.now() })),
  },
};
```

The browser client mirrors the object:

```ts
const greeting = await api.greeting();
const { timestamp } = await api.clock.now();
```

Return JSON-serializable values from handlers. Keep Node-only packages and secrets in `api.ts`; do not import them into `view.tsx`.

## Inputs and outputs

Use `type<T>()` when TypeScript checking is sufficient:

```ts
import { os, type } from "@get-halo/extension-sdk/api";

const rename = os
  .input(type<{ id: string; label: string }>())
  .output(type<{ saved: true }>())
  .handler(async ({ input }) => {
    return { saved: true as const };
  });
```

Use `Type` when the server must validate untrusted runtime input:

```ts
import { os, Type } from "@get-halo/extension-sdk/api";

const search = os
  .input(
    Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
  )
  .handler(async ({ input }) => {
    return { query: input.query, limit: input.limit };
  });
```

The handler receives oRPC's normal fields, including `input`, `context`, and `signal` when relevant. Pass `signal` to external work that supports cancellation.

## Router types in the view

Import the router as a type so the browser bundle does not pull server implementation code into the view:

```ts
import type router from "./api.js";
import type schema from "./schema.js";
import type { ExtensionViewProps } from "@get-halo/extension-sdk/view";

export default function View({
  api,
  storage,
}: ExtensionViewProps<typeof router, typeof schema>) {
  // api is inferred from the complete router.
}
```

Keep the `.js` suffix on local ESM imports even though the source file is TypeScript.

## Failures

An exception leaving an API handler becomes a rejected browser API promise. Convert expected failures from application code to an exception only at this RPC boundary. Convert throwing libraries where they are called, and preserve their cause.

In the view, catch rejected calls and show a useful error state:

```ts
import * as errore from "errore";

class ExtensionApiError extends errore.createTaggedError({
  name: "ExtensionApiError",
  message: "Could not load the extension title",
}) {}

const title = await api
  .title()
  .catch((cause) => new ExtensionApiError({ cause }));
if (title instanceof Error) {
  setError(title.message);
  return;
}
setTitle(title);
```

Do not treat a browser with no uncaught runtime errors as proof that an API call succeeded. A caught rejection must still be asserted through the rendered success or failure state.
