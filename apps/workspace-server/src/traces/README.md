# Agent run archives

Halo records one immutable gzip-compressed JSONL file per run. A session can
contain many runs, including requests made after a server restart. Capture is
owned by the workspace server and does not require a chat watcher.

`TraceRecord` in `@get-halo/client` is the versioned envelope. Every record has
`schemaVersion`, `workspaceId`, `sessionId`, `traceId`, `spanId`, `sequence`,
`timestamp`, and `type`. Child operations carry `parentSpanId`. IDs use
OpenTelemetry's 32-hex trace and 16-hex span forms. This is a Halo archive format,
not an OTLP transport. GenAI operation, provider, model, and tool attributes use
OpenTelemetry names; Pi messages and provider payloads are preserved in `data`.

## Contents

- `run.started`: agent identity, application version, and Pi operation/version.
- `model.started`: Pi context (system prompt, history, tool schemas), model
  identity, and explicitly supplied inference settings.
- `model.payload`: the provider request body after Pi's payload hook. This
  records provider defaults and translations beyond the inference boundary.
- `model.finished`: final or partial-on-error assistant message, usage, stop
  reason, and any provider-reported error.
- `tool.started` / `tool.finished`: arguments, result, and failure status.
- `integration.started` / `integration.finished`: nested Executor calls,
  including their results, under the outer `exec` span.
- `pi.*`: committed messages, steering queues, context compaction, configuration
  changes, retry events, and errors. Token-by-token streaming deltas are omitted.
- `run.finished`: `completed`, `failed`, `cancelled`, or `interrupted`.

Every model call contains its own configuration and effective input; there is no
separate prompt registry. Authentication headers, API keys, and provider environment
variables are not copied from the transport. Conversation and tool content is
captured in full, including any sensitive content supplied by the user or tools.
Provider payload capture depends on the LLMApi implementation honoring Pi's
`onPayload` callback. It is supported by both bundled inference backends.

## Local durability and upload

The stable workspace UUID lives at `.halo/traces/workspaceId`. Active runs append
and flush to `.halo/traces/active/<sessionId>/<traceId>.jsonl`. On completion,
the server compresses the file into `pending/` and removes the active file.

Pending files use this object key:

```text
v1/workspaces/<workspaceId>/sessions/<sessionId>/<traceId>.jsonl.gz
```

The host can supply `WorkspaceServer.start({ traceUploader, ... })`. Uploads happen
in the background after completion, on startup, and every 30 seconds while there
is pending data. Failed uploads remain pending. Successful uploads move the local
copy from `pending/` to `archive/`; local and remote archives have no automatic
expiry. Hosts without an uploader retain pending files locally.

Restart recovery discards an incomplete final JSON line and adds an `interrupted`
outcome to unfinished runs. A complete terminal record is preserved if shutdown
interrupted compression. Active runs are not available centrally until finalized.
This recovers durable records, not unrecorded work or the lost process itself.

## Extension agents

Agents that run their own loops explicitly record through the authenticated Halo
client. The extension owns its agent ID/version, operation spans, and data shape:

```ts
const run = await halo.traces.start({
  sessionId: "expense-conversation-42",
  agent: { id: "expenses", version: "build-12" },
});
await halo.traces.record({
  traceId: run.traceId,
  event: {
    type: "model.started",
    spanId: "1234567890abcdef",
    parentSpanId: run.spanId,
    data: { systemPrompt: "...", messages: [], tools: [] },
  },
});
await halo.traces.finish({ traceId: run.traceId, outcome: "completed" });
```

Generate a new random 16-hex span ID for each operation. Session IDs may contain
letters, numbers, underscores, and hyphens, up to 128 characters. The server
assigns trace IDs, sequence numbers, and timestamps. Arbitrary extension model
calls are not captured automatically. Unfinished extension runs are finalized as
interrupted when the server shuts down or restarts.

To inspect a downloaded run:

```sh
gzip -dc <traceId>.jsonl.gz | jq .
```

## GCP host

Set `traceBucket` in the workspace-server JSON configuration. For local
development, opt into uploading with `HALO_TRACE_BUCKET`; otherwise traces stay
local. The standalone host constructs `GcsTraceUploader` with Application Default
Credentials. GCP VMs use their attached service account, with no stored upload key.

The uploader sends a media upload with `ifGenerationMatch=0`. A successful response
or GCS's `412` response for an existing immutable object acknowledges the local
file. Other responses or transport failures leave it pending. Each HTTP upload
has a 20-second timeout; the service retries from the durable file on its next pass.
The bucket stores gzip bytes with `application/gzip` rather than HTTP content
encoding, so downloading preserves the archive bytes.

Pulumi creates `halo-relay-halo-west-traces` in `us-west2` on the production
`west` stack. It grants workspace identities only `roles/storage.objectCreator`.
The bucket blocks public access, has no lifecycle expiry, retains soft-deleted
objects for 30 days, and is protected from Pulumi deletion. Readers use separately
authorized operator credentials; workspace agents cannot read other users' traces.

```sh
gcloud storage ls --recursive gs://halo-relay-halo-west-traces/v1/workspaces/
gcloud storage cp gs://halo-relay-halo-west-traces/v1/workspaces/WORKSPACE/sessions/SESSION/TRACE.jsonl.gz ./
```
