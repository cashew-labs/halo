# Halo tools in extensions

A Halo-hosted API handler receives `context.tools`. This calls the same workspace tools and connected integrations available to the Halo agent. Keep every tool call in `api.ts`; the browser view calls a typed API procedure.

Workspace extensions are trusted and can call any available tool. There is no extension permission manifest or per-call approval layer. This authority does not connect accounts and does not expand the user's requested task.

## Tool result contract

Import `ExtensionToolResult` from `@get-halo/extension-sdk/api`:

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

Narrow the API builder's context to the tools the extension consumes:

```ts
import { os, type ExtensionToolResult } from "@get-halo/extension-sdk/api";

const api = os.$context<{
  tools: {
    files: {
      read(input: {
        path: string;
      }): Promise<ExtensionToolResult<{ path: string; text: string }>>;
    };
  };
}>();

export default {
  notes: api.handler(async ({ context }) => {
    const result = await context.tools.files.read({ path: "notes.txt" });
    if (!result.ok) throw new Error(result.error.message);
    return result.data.text;
  }),
};
```

The type declaration describes the existing runtime contract; it does not create a tool or grant access. Keep it aligned with the live schema. For several procedures, define the narrowed builder once and reuse it.

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

Tool calls return failures as values; they do not reject for ordinary tool failures. Convert a failed result to the extension's domain error, then throw only as it leaves the oRPC handler so the browser API promise rejects. The view must render that rejection.

Do not retry mutations unless the operation is known to be idempotent and the user asked for retry behavior. The optional `retryable` field describes the failure; it is not permission to repeat an external action.
