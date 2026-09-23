# Server and API SDK

`extension.ts` default-exports an extension definition containing a Hono API, the Tandem schema and relations, and the view kind. Halo mounts the Hono app at `/api/`; the browser receives an inferred `hc` client.

## Define an extension

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

Chain Hono route declarations so its inferred route schema includes every endpoint. Keep Node-only packages and secrets in `extension.ts`; import the definition into `view.tsx` with `import type`.

## Inputs and outputs

Use Hono's request validation and response helpers. Return explicit JSON statuses for expected failures:

```ts
const api = new Hono<ExtensionEnvironment>().post("/todos", async (context) => {
  const input = await context.req.json<{ label: string }>();
  if (input.label.trim().length === 0) {
    return context.json({ error: "A label is required" }, 400);
  }
  return context.json({ id: crypto.randomUUID(), label: input.label }, 201);
});
```

The browser client exposes this route as `api.todos.$post()`. Check `response.ok`, then parse the typed body.

## Halo tools

Hono handlers receive the hosted tool client through `context.env.tools`:

```ts
const api = new Hono<ExtensionEnvironment>().get("/notes", async (context) => {
  const result = await context.env.tools.files.read<{
    path: string;
    text: string;
  }>({ path: "notes.txt" });

  if (!result.ok) {
    return context.json({ error: result.error.message }, 500);
  }
  return context.json({ text: result.data.text });
});
```

Tool failures are values. Convert them to the extension's HTTP response at the Hono boundary; do not blindly retry mutations.

## WebSockets

Import the SDK's Hono-compatible helper. Halo owns the listener, WebSocket server, authentication proxy, and shutdown:

```ts
import { upgradeWebSocket } from "@get-halo/extension-sdk/server";

const api = new Hono<ExtensionEnvironment>().get(
  "/events",
  upgradeWebSocket(() => ({
    onOpen(_event, socket) {
      socket.send("ready");
    },
    onMessage(event, socket) {
      socket.send(event.data);
    },
  })),
);
```

The browser opens this route through the inferred client:

```ts
const socket = api.events.$ws();
```

Close browser sockets when their component unmounts. The SDK closes remaining server sockets when the extension stops.

## Lifecycle and proxy views

Use `serve()` only when the extension needs startup work or a server-backed view:

```ts
import { defineExtension, proxyView } from "@get-halo/extension-sdk/server";

export default defineExtension({
  api,
  schema,
  relations,
  view: proxyView(),

  async serve({ tools, dataDirectory }) {
    const started = await tools.bash.run<{ value: { stdout: string } }>({
      command: `code-server-manager start --data-dir ${dataDirectory.path}`,
    });
    if (!started.ok) return new Error(started.error.message);

    return {
      view: {
        target: started.data.value.stdout.trim(),
        stripPrefix: true,
      },
      async close() {
        const stopped = await tools.bash.run({
          command: `scripts/stop-service ${dataDirectory.path}`,
        });
        if (!stopped.ok) return new Error(stopped.error.message);
      },
    };
  },
});
```

The target must be a loopback HTTP origin. Halo forwards `/view/*` HTTP and WebSocket traffic and strips its own credentials. Startup and stop shell commands must be finite; a background service script owns its PID file.

## API types in the view

```ts
import type extension from "./extension.js";
import type { relations, schema } from "./schema.js";
import type { ExtensionViewProps } from "@get-halo/extension-sdk/view";

export default function View({
  api,
  storage,
}: ExtensionViewProps<typeof extension, typeof schema, typeof relations>) {
  // api is inferred from extension.api.
}
```
