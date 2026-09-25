# Migrating an extension to SDK 0.3

SDK 0.3 replaces the source-level `api.ts` oRPC router with a Hono API inside `extension.ts`. Existing SDK 0.2 build output remains compatible with Halo's process, URL, readiness, and shutdown protocol. Migrate source explicitly before editing it with 0.3 examples.

## Update exact dependencies

```sh
npm install --save-exact @get-halo/extension-sdk@0.3.0 hono@4.13.8
npm install --save-dev --save-exact @get-halo/extension-tools@0.3.0
```

Keep SDK and tools on the same exact version.

## Replace `api.ts`

Create `extension.ts` with a Hono app:

```ts
import { Hono } from "hono";
import {
  defineExtension,
  reactView,
  type ExtensionEnvironment,
} from "@get-halo/extension-sdk/server";
import { relations, schema } from "./schema.js";

const api = new Hono<ExtensionEnvironment>().get("/hello", (context) =>
  context.json({ message: "Hello" }),
);

export default defineExtension({
  api,
  schema,
  relations,
  view: reactView("./view.tsx"),
});
```

Delete `api.ts`.

## Update the view client

Import the extension definition as a type:

```ts
import type extension from "./extension.js";
import type { relations, schema } from "./schema.js";

type Props = ExtensionViewProps<
  typeof extension,
  typeof schema,
  typeof relations
>;
```

Replace oRPC procedure calls with Hono client calls:

```ts
const response = await api.hello.$get();
const body = await response.json();
```

## Update scripts and check

Add the canonical check script:

```json
{
  "scripts": {
    "check": "npm run typecheck",
    "build": "halo-extension build",
    "start": "node dist/start.mjs",
    "typecheck": "tsc --noEmit"
  }
}
```

Then run:

```sh
npm run check
npm run build
halo extension restart <id>
```

Build publication is atomic. When check or build fails, `dist/current.json` continues pointing at the prior successful SDK 0.2 generation. Hosted Tandem data remains under the same extension data directory.
