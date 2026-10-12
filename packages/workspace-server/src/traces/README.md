# Agent run archives

The trace API records one immutable gzip-compressed JSONL file per explicitly
recorded run. A session can contain many runs, including requests made after a
server restart. The main Pi Durable agent does not currently feed this API.
The normal workspace application does not configure an uploader, so recording
through the API stays local and starts no upload timer.

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

The stable workspace UUID lives at `.halo/traces/workspaceId`. Managed VMs use
the workspace UUID assigned by the control plane; local workspaces generate one.
A configured UUID must match the saved identity on restart. Active runs append
and flush to `.halo/traces/active/<sessionId>/<traceId>.jsonl`. On completion,
the server compresses the file into `pending/` and removes the active file.

Pending files use this object key:

```text
v1/workspaces/<workspaceId>/sessions/<sessionId>/<traceId>.jsonl.gz
```

An embedding host can explicitly supply
`WorkspaceServer.start({ config, host: { traceUploader, ... } })`. Only then do
uploads happen after recorded-run completion, on startup, and on a 30-second
pending-file check. The normal workspace application supplies no transport.

Each archive has **at most two uploader attempts total**. Its attempt count is
flushed to a `.attempts` sidecar before calling the uploader, so restarts and
crashes cannot reset the budget. After a transient first failure, one retry is
eligible after 30 seconds; there is no exponential backoff. A second transient
failure moves the original file to `failed/`. A file does not block later ones.
An unreadable or invalid counter prevents sending that file rather than resetting
its budget. Completion/timer notifications coalesce while work is queued.

The control-plane uploader checks shared 16 MiB compressed / 64 MiB expanded
limits locally. An oversized archive is replaced **for transmission only** by a
small gzip JSONL report. It contains synthetic `run.started` / `run.finished`
report boundaries and an `archive.truncated` event, explicitly stating that the
full archive was not uploaded. Its data includes the reason, original compressed
size, limits, and up to 64 KiB of complete beginning JSONL lines as preview text.
A line crossing the preview boundary is omitted; the report does not claim to
be the original complete agent run. If the beginning cannot be decompressed, a
metadata-only report identifies the preview failure.

A successfully uploaded preview leaves the complete original in `rejected/`.
Invalid keys/gzip and HTTP 400/413/415/422 are permanent failures and also move
there without retry. A transient preview-upload failure consumes an attempt and
uses the same two-attempt budget. Authentication failures remain transient; no
credential refresh is performed by the uploader.

Successful full uploads move their local copies to `archive/`. Attempt sidecars
move alongside terminal archives. Local, rejected, failed, and remote files have
no automatic expiry. Hosts without a transport retain pending files locally.

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

## Control-plane upload boundary

When explicitly configured by an embedding host, `ControlPlaneTraceUploader`
sends an archive or preview report to `POST /api/traces/<sessionId>/<traceId>`
using that host's workspace runtime bearer token. Each request has a 60-second
timeout. The normal managed workspace application leaves this uploader disabled.

The control plane authenticates the runtime credential against the registered
workspace, derives its destination prefix from that identity, and validates gzip
JSONL identities, ordering, and report/run boundaries. It uploads with
`ifGenerationMatch=0`; an existing object's `412` response acknowledges a retry
without overwriting its bytes. Other storage failures return an error to the host.
Archives use `application/gzip` without HTTP content encoding.

The workspace does not get direct access to the trace bucket. Only the
control-plane service account has object-creation access. The uploader never
exports or queries the conversation database and does not restore automatic
main-agent trace capture.
