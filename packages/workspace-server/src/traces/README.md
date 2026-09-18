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

The stable workspace UUID lives at `.halo/traces/workspaceId`. Managed VMs use
the workspace UUID assigned by the control plane; local workspaces generate one.
A configured UUID must match the saved identity on restart. Active runs append
and flush to `.halo/traces/active/<sessionId>/<traceId>.jsonl`. On completion,
the server compresses the file into `pending/` and removes the active file.

Pending files use this object key:

```text
v1/workspaces/<workspaceId>/sessions/<sessionId>/<traceId>.jsonl.gz
```

The host can supply
`WorkspaceServer.start({ config, host: { traceUploader, ... } })`. Uploads
happen in the background after completion, on startup, and every 30 seconds
while there is pending data. Failed uploads remain pending. Successful uploads
move the local copy from `pending/` to `archive/`; local and remote archives
have no automatic expiry. Hosts without an uploader retain pending files
locally.

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

## GCP upload boundary

Managed workspace VMs configure `traceUpload: { origin, workspaceId }`. The
control plane provisions both values in VM metadata; the startup script writes
them into the workspace-server configuration. Local development and standalone
VMs retain traces locally unless configured as a registered managed workspace.

`ControlPlaneTraceUploader` sends a finished archive to
`POST /api/traces/<sessionId>/<traceId>` on the control plane. It obtains a
Google-signed full Compute Engine identity token for the `/api/traces` audience
using Application Default Credentials. Uploads remain asynchronous; failures
leave the file pending for retry. The client waits up to 60 seconds per upload.

The control plane verifies the token's signature, issuer, audience, expiry,
service account, project and zone. It requires signed VM claims, checks the
instance ID against the current Compute Engine instance, and checks that the
workspace named by that VM is registered in its database. A token identifying
only the shared workspace service account is insufficient. This authenticates
the VM's registered workspace/owner without storing the user's login session
on the VM. See [Google's VM identity documentation](https://docs.cloud.google.com/compute/docs/instances/verifying-instance-identity).

The endpoint constructs the destination using that verified workspace UUID;
it never accepts a caller-selected workspace path or bucket. It validates the
gzip JSONL envelope against the verified workspace and requested session/run,
including record ordering and start/end boundaries. Uploads are limited to
16 MiB compressed and 64 MiB expanded. Invalid or oversized archives are
rejected and remain local. Event content is still agent-supplied data, not an
independent attestation of what happened.

Only the control-plane service account has `roles/storage.objectCreator` on
the trace bucket. Workspace service accounts have no trace-bucket grant. The
control plane uploads with `ifGenerationMatch=0`; an existing object's `412`
response acknowledges an immutable retry without overwriting its bytes.
Other storage failures return an error to the VM, preserving its pending file.
Archives use `application/gzip` without HTTP content encoding.

Pulumi creates `halo-relay-halo-west-traces` in `us-west2` on the production
`west` stack. The bucket blocks public access, has no lifecycle expiry, retains
soft-deleted objects for 30 days, and is protected from Pulumi deletion.
Readers use separately authorized operator credentials.

Deploy the control-plane endpoint and IAM change before replacing workspace
VMs with the new uploader/configuration. The standalone development VM has no
production workspace registration and therefore keeps local archives only.

```sh
gcloud storage ls --recursive gs://halo-relay-halo-west-traces/v1/workspaces/
gcloud storage cp gs://halo-relay-halo-west-traces/v1/workspaces/WORKSPACE/sessions/SESSION/TRACE.jsonl.gz ./
```
