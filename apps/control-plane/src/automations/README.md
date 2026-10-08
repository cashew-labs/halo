# Automation ingress

Webhook URLs use the control plane's public origin and one parameterized route,
`POST /api/webhooks/:id`. There is no server or route registration per user.
The workspace registration determines the owner and automation; callers cannot
choose a workspace in the payload.

Owners retrieve or rotate credentials through `automations.webhookAccess`.
Prefer `Authorization: Bearer <token>`. The returned private URL supports services
that only accept a URL. Tokens are 256 random bits, stored as SHA-256 digests for
verification and encrypted under an isolated credential owner namespace for
owner retrieval. Executor integration credential APIs cannot access that namespace.

Send a JSON object (256 KiB maximum), or an empty body. The response is `202` only
after durable storage. `Idempotency-Key` retries return the same event ID for the
same definition revision and JSON serialization; changed content returns `409`.
Receipts and idempotency keys expire after seven days. The workspace queues actions
per automation. Delivery retries for up to 24 hours; a lost response cannot run
the same event twice. Actions interrupted during execution are not retried.

## Deployment

The Pulumi control-plane stack excludes `/api/webhooks/` HTTP request logs from
Cloud Logging's `_Default` sink. The application never logs or forwards incoming
URLs, headers, or query parameters. Before enabling URL-token use in a deployment,
ensure every additional project or inherited organization/folder export sink uses
the same exclusion (`httpRequest.requestUrl =~ "/api/webhooks/"`). Google log
exclusions are sink-specific; `_Default` does not protect separate sinks. Retain
status and delivery diagnostics through automation history. Token-bearing URLs
must not be pasted into logs or analytics.

The integration encryption key is also required for webhook provisioning. Without
it, source status reports needsAttention instead of returning an unusable endpoint.

## Gmail

One Pub/Sub topic and authenticated push subscription serve the environment.
The push service account, expected audience and topic are control-plane settings;
users only select an existing Gmail connection. Gmail requires the topic project
to match the Google developer project of the OAuth app making `users.watch`.
The Pulumi stack provisions the topic, publisher permission, push identity and
subscription. Deploy those resources together with the control-plane revision.

Mailbox identity comes from `users.getProfile` through the user's existing
Executor connection, with trigger HTTP requests restricted to Google Gmail and
OAuth token endpoints. Editable integration definitions cannot substitute a fake
mailbox response. The login email and push payload never select a Halo owner.
A signed Google OIDC token with the configured audience and verified push service
account is required. Notifications mark an already verified mailbox dirty before
acknowledgement. History cursors advance only with committed matched deliveries.

Triggers start at the current history ID, listen to new INBOX messages, and exclude
SENT and DRAFT messages. Sender matches one exact email address; subject matching
is case-insensitive substring matching. No historical backfill is performed.
Shared watches renew every 20–24 hours, with five-minute history reconciliation
when notifications are quiet. An expired history cursor resets to the current
profile cursor and leaves a visible gap notice. Revoked connections require
attention. Every owner's connection is revalidated before mailbox fanout.

Gmail payloads contain mailbox/message/thread identifiers, From, Subject and a
snippet. Actions can use the existing Gmail tools to fetch additional content.
