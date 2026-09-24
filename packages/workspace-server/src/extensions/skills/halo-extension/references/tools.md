# Halo tools in extensions

A Halo-hosted Hono handler receives `context.env.tools`. The optional `serve()` lifecycle receives the same client as `tools`. This calls the same workspace tools and connected integrations available to the Halo agent. Keep tool calls in `extension.ts`; the browser view calls a typed API route.

Workspace extensions are trusted and can call any available tool. There is no extension permission manifest or per-call approval layer. This authority does not connect accounts and does not expand the user's requested task.

## Tool result contract

Import `ExtensionToolResult` from `@get-halo/extension-sdk/server`:

```ts
type ExtensionToolResult<Data = unknown> =
  | {
      ok: true;
      data: Data;
      http?: { status: number; headers: Record<string, string> };
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        status?: number;
        details?: unknown;
        retryable?: boolean;
      };
    };
```

Always check `ok` before reading `data`. Preserve useful failure information when returning an error to the view.

Tool inputs are JSON-like values: strings, numbers, booleans, external `null`, nested objects, and arrays. Tool outputs follow the result contract above.

## Discover and type a tool

Tool paths and inputs match Halo's live tool catalog. Before coding, use the agent's tool search and schema-description facilities to find the canonical path, input, and output. Do not guess service operations or copy a contract from an unrelated provider.

```ts
import { Hono } from "hono";
import type {
  ExtensionEnvironment,
  ExtensionToolResult,
} from "@get-halo/extension-sdk/server";

type NotesTools = {
  files: {
    read(input: {
      path: string;
    }): Promise<ExtensionToolResult<{ path: string; text: string }>>;
  };
};

const api = new Hono<ExtensionEnvironment<NotesTools>>().get(
  "/notes",
  async (context) => {
    const result = await context.env.tools.files.read({ path: "notes.txt" });
    if (!result.ok) {
      return context.json({ error: result.error.message }, 500);
    }
    return context.json({ text: result.data.text });
  },
);
```

The type argument describes the existing output contract; it does not create a tool or grant access. Keep it aligned with the live schema.

## Connected services

Use the requested connected service as the source of truth. Do not silently replace unavailable live data with samples or local Tandem records.

If the service has no connection, have the user connect it in Halo. A tool failure may include a code, status, details, or `retryable`; use those fields when they materially improve the visible recovery message. Do not put OAuth tokens, API keys, cookies, or other provider credentials into source code, frontend state, Tandem, or extension files.

## Hosted and standalone behavior

Halo supplies the tool origin and a per-extension bearer token only to the hosted server process. The SDK uses them internally and strips the browser away from that credential.

A standalone server still supports its own API and Tandem storage, but every Halo tool call returns:

```ts
{
  ok: false,
  error: {
    code: "halo_not_connected",
    message: "Start this extension through Halo to use workspace tools.",
  },
}
```

Test connected-service and workspace-tool behavior only through the Halo-hosted extension URL. Standalone success cannot prove the tool bridge works.

## Failure boundary

Tool calls return failures as values; they do not reject for ordinary tool failures. Convert a failed result to an explicit Hono error response. The view must render that response.

Do not retry mutations unless the operation is known to be idempotent and the user asked for retry behavior. The optional `retryable` field describes the failure; it is not permission to repeat an external action.
