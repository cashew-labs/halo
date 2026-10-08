# Move integrations to the control plane

Status: **Phases 1–5 and 7 implemented; Phase 6 removed. Phase 8 verification is recorded below.** Keep Executor 1.6.0 for workspace execution and control-plane integrations, not v2 or Pi codemode. Existing local approvals remain unchanged. Deployment requires separate authorization.

## Problem overview

The workspace's `ToolRuntime` currently combines code execution, local tools, integration discovery, OAuth and credentials. Connections belong to workspace-local storage. Moving all of `exec` to the control plane would make file and shell operations travel back to the workspace VM.

## Solution overview

Keep code execution and extensions on the workspace. `ControlPlane` owns `DatabaseService`, `CredentialService` and `IntegrationService`. It passes the same database service to both child services and passes the credential service to the integration service. `IntegrationService` creates and owns its Executor database adapter internally, constructs user-bound Executor instances, and presents a small authenticated API to workspace VMs. Executor owns integration behavior, catalog and policy evaluation.

```mermaid
flowchart LR
  subgraph Workspace[Workspace VM]
    Agent[Run exec with Executor QuickJS] --> Runtime[ToolRuntime]
    Extensions[Existing extension runtime] --> Runtime
    Runtime --> Local[Files, shell and local tools]
    Runtime --> Client[IntegrationClient]
  end
  subgraph CP[Existing control-plane server]
    Client --> Auth[Runtime authentication]
    Auth --> Service[IntegrationService]
    Service --> Executor[User-bound Executor]
    Service --> Adapter[Internal Executor database adapter]
    Executor --> Adapter
    Adapter --> Database[DatabaseService]
    Executor --> Provider[Adapt credentials inside IntegrationService]
    Provider --> Credentials[CredentialService: plain async storage]
    Credentials --> Database
    Database --> SQL[SQL metadata, policies and encrypted tokens]
    Secrets[GCP Secret Manager: encryption key] --> Credentials
    Executor --> API[External integration API]
  end
```

Only discovery and individual integration calls cross the network. JavaScript, files, shell, extension code and extension data remain on the workspace. Connections belong to a user across their workspaces; users reconnect rather than migrating old connections.

## Goals

- Keep `IntegrationService` a friendly wrapper around Executor, not a second integration framework.
- Use Executor's own schema definitions and initialization helpers instead of copied Executor SQL.
- Keep credentials and encryption keys off workspace VMs and tool responses.
- Preserve non-blocking approvals and automatic connection/permission cards.
- Keep local tools usable during control-plane outages.

## Non-goals

- Executor v2, Executor apps, a separate integration-server deployment, or moving extension execution.
- Migrating or deleting existing workspace connection data.
- Per-invocation, per-tool or per-connection approval preferences, a new persistent policy engine, or control-plane stdio MCP processes. Automatic approval uses Executor's native tenant-scoped org policy.
- Automatic replay of JavaScript or retry of writes with an unknown outcome.
- Provisioning production secrets, applying shared-database changes or deploying without separate authorization.

## Ownership and contracts

### ControlPlane owns the three services

`DatabaseService` owns database connections and their lifetime. `CredentialService` borrows it to store encrypted credentials through plain async `get`, `set`, `list` and `delete` methods, each scoped by user ID. `IntegrationService` borrows both services and builds the user-bound Executor credential provider internally. Its database adapter, Effect adapters and Executor instances are not top-level dependencies constructed by `ControlPlane`.

```callstack
 Start ControlPlane [[apps/control-plane/src/server/ControlPlane.ts#ControlPlane.start]]
 ├── instantiate DatabaseService [[apps/control-plane/src/DatabaseService.ts#DatabaseService.start]]
+├── instantiate CredentialService with DatabaseService and encryption key
+└── instantiate IntegrationService with DatabaseService and CredentialService
+    ├── initialize Executor schema and create internal database adapter
+    └── instantiate user-bound Executor with adapter and credential provider
```

Initialize dependencies in that order and release resources in reverse order, including failed startup. Shut down integration work and Executor instances before closing the database service. CredentialService owns no independently disposable connection; neither child closes the borrowed database service.

### Executor owns its database schema

Executor 1.6.0 accepts a FumaDB query interface, not a raw SQL client. Inside `IntegrationService`, build a thin adapter over the supplied `DatabaseService` using `createDrizzleRuntimeSchemaFromTables`, `ensureDrizzleRuntimeSchemaFromTables` and `createExecutorFumaDb`. Initialize it once before constructing user-bound Executor instances. `ControlPlane` does not construct or pass an Executor database handle.

The installed initialization helper creates missing tables and indexes; it does not alter existing columns. Review schema-changing SDK upgrades separately. Do not copy Executor's table definitions into Halo migrations. Halo owns only the small schema for its credential provider.

Development uses SQLite and production uses PostgreSQL. DatabaseService owns both local files: `control-plane.db` for auth/workspaces/encrypted credentials and `control-plane.db.integrations` for Executor metadata. Separating SQLite files prevents synchronous auth writes from blocking an asynchronous Executor transaction; the internal adapter serializes whole Executor transactions with SerialQueue. PostgreSQL uses the existing shared pool and real driver transactions. There is still one top-level DatabaseService. Executor's namespace only names its settings table, not every data table.

```ts
// Phase 1 composition, simplified: omit error branches and cleanup here.
const db = await DatabaseService.start(databaseConfig);
const credentials = await CredentialService.start({ db, encryptionKey });
const integrations = await IntegrationService.start({ db, credentials });

// Inside IntegrationService.start: create and retain its private adapter.
const executorDb = await createExecutorDatabase(db);

// Inside IntegrationService: bind identity supplied by a trusted internal caller.
// Phase 2 derives it from authenticated runtime state.
const executor = await Effect.runPromise(createExecutor({
  tenant: Tenant.make(userId),
  subject: Subject.make(userId),
  db: executorDb,
  providers: [this.credentialProvider(userId)],
  plugins: [googleOpenApiPlugin],
  onElicitation: () => Effect.succeed({ action: "decline" }),
}));
```

### CredentialService stores secrets; IntegrationService adapts the provider

Executor asks a user-bound provider constructed inside `IntegrationService` to read or write token values by opaque ID. That provider delegates to CredentialService's plain promises, converts returned errors into Executor storage failures, and maps missing values from `undefined` to Executor's `null`. CredentialService imports neither Effect nor Executor. It stores values encrypted through its supplied DatabaseService, with authenticated encryption binding each value to the user and credential ID. Load the encryption key from GCP Secret Manager in the control plane and pass it to CredentialService. Shared deployment secrets, such as the OAuth application secret, also stay in Secret Manager.

Keep key provisioning, backups and rotation explicit. Never generate a replacement key at each startup. Database encryption does not protect against a compromised control-plane process with access to the key. Executor's temporary OAuth state, including PKCE verifiers, needs separate review; it does not automatically pass through the credential provider.

### Authentication determines the owner

Authenticate workspace calls with runtime credentials and derive the user on the control plane. Do not trust caller-provided owner IDs. Bind Executor instances to one immutable identity and manage their lifetime. Two workspaces for one user share connections; another user cannot discover or invoke them. Wire development through the same authenticated boundary.

Expose JSON-only operations for search, describe, invoke and connection setup/status. Normalize SDK errors at this boundary, bound payloads, and do not send provider tokens to the workspace. Connection listing requires a human session. Runtime callers cannot supply policy patterns or change restrictions; automatic approval is configured by the service during initialization.

### Automatically approve connected integrations through Executor's native policy

The user's decision is to automatically approve all connected integration tools. During each per-user Executor initialization, IntegrationService checks native persisted policies for owner `org`, pattern `*`, action `approve`, and creates that rule only if absent. Executor's tenant and subject are bound to the authenticated user's ID: `org` is scoped to that user's tenant, not a global cross-user grant. Existing and future connections use this fallback without opt-in, including agent and background-extension calls. OAuth scopes, credential entry and connection readiness are unchanged.

```mermaid
sequenceDiagram
  participant U as User
  participant I as IntegrationService
  participant E as Executor
  I->>E: Initialize Executor bound to user's tenant
  I->>E: List native persisted policies
  opt No existing org wildcard approve rule
    I->>E: Persist org pattern * action approve
  end
  U->>I: Complete OAuth or secure credential entry
  I-->>U: Connected; no approval preference
  I->>E: Execute tool; evaluate native policies
  E-->>I: Return result or native approval/block outcome
```

Executor stores the fallback in its existing database. There is no custom preference plugin, managed rule association, preference queue or advisory lock. Native rule ordering and the most restrictive org/user combination remain authoritative: explicit restrictive policies still win. Initialization does not overwrite or remove independent rules. The existing-rule check avoids reseeding on ordinary restart; it is not a claim of cross-replica atomic uniqueness.

Do not configure `accept-all`: the native approve policy skips pre-call approval, but an MCP tool can still request input during execution. Unsupported elicitations remain declined. Explicit require-approval policies can still yield `approval_required`, and blocks still prevent dispatch. Automatic approval does not authenticate a connection, expand OAuth scopes, stop in-flight actions or bypass restrictions.

The agent never waits for human input. Return structured connection-setup metadata and show the connection card without another model turn. Cards appear when the enclosing exec result is published. Background extensions receive an actionable not-ready result without a card. Approval does not replay scripts or retry a timed-out mutation.

## Implementation phases

Phases 1–3, including native automatic approval, durable setup and browser onboarding, are implemented locally. Phase 4 delivers explicit remote cards and setup status, but not automatic cards from remote invocation failures. Phase 5 routing and Phases 6–8 remain planned. Validate behavior within the phase that introduces it. Actual implementation patches are embedded below; labelled historical checkpoints retain their original evidence.

### ✅ Phase 1: Start IntegrationService with persistent Executor instances

**Today**

The workspace constructs Executor with both local tools and integration presets, and persists metadata and credential files locally. The control plane has no integration service or credential service.

**Proposed**

Have `ControlPlane` instantiate `CredentialService` and `IntegrationService`, passing the same `DatabaseService` to both and the credential service to the integration service. Inside `IntegrationService`, initialize the private Executor database adapter with SDK-owned schema helpers and construct user-bound Executor instances with the current Google presets. Preserve the Meet exclusion and keep workspace-local tools out of those instances. Avoid an `IntegrationStore` abstraction and copied Executor migrations.

```callstack
 Start ControlPlane [[apps/control-plane/src/server/ControlPlane.ts#ControlPlane.start]]
 ├── instantiate DatabaseService [[apps/control-plane/src/DatabaseService.ts]]
+├── instantiate CredentialService with database service and encryption key [[phase1-host:new:104-111]]
+│   └── read and write encrypted credential values [[phase1-credentials:new:74-118]]
+└── instantiate IntegrationService with database and credential services [[phase1-host:new:112-121]]
+    ├── initialize Executor schema and create its private FumaDB adapter [[phase1-adapter:new:21-68]]
+    └── instantiate user-bound Executor and register existing integration presets [[phase1-integrations:new:147-210]]
```

**Implemented:** ControlPlane starts the internal service when supplied an encryption key. `withUser(userId, operation)` is a trusted in-process seam, not an authenticated remote API. It coalesces first use of a user, binds Executor's tenant and subject to that identity, installs the Google presets except Meet, and persists native catalog, connection and policy state. The only plugin is OpenAPI; no workspace file or shell tools are installed. Elicitations currently decline immediately, without creating cards or grants. Phase 4 adds those.

Shutdown rejects new operations, drains accepted work and closes Executor instances before DatabaseService. Failed initialization releases acquired resources. Credentials use AES-256-GCM, fresh nonces and authenticated data bound to user plus credential ID. Credential-provider calls are not wrapped in Executor transactions.

#### Code outline

The implementation has five responsibilities. Executor still owns catalog, connection and policy behavior; Halo supplies composition, database access, credential encryption and lifecycle.

| Code | What it does |
| --- | --- |
| `readIntegrationEncryptionKey()` in `packages/config/src/controlPlane.ts` | Read the fixed Secret Manager name, decode base64 and require a 32-byte key. `main.ts` passes that key into ControlPlane. [[phase1-config:new:118-130]] [[phase1-main:new:37]] |
| `ControlPlane.start()` / `close()` | Instantiate the database, then credentials and integrations with that same database service. Pass an optional semantic `getOpenAPISpec(url): Promise<string \| Error>` dependency, never an HTTP client or Effect layer. On shutdown, stop HTTP, drain integrations, then close the database. [[phase1-host:new:104-124]] [[phase1-host:new:153-162]] |
| `DatabaseService` | Own the PostgreSQL pool or both SQLite connections. Expose `client` for existing services/credentials and `integrationClient` for the Executor adapter; close the connections it owns. [[phase1-database:new:61-95]] |
| `CredentialService` | Initialize Halo's credential table. Expose plain async `get`, `set`, `list` and `delete`, scoped by user ID. Return domain errors as values and `undefined` for missing credentials. Encrypt on write and authenticate/decrypt on read. [[phase1-credentials:new:60-118]] [[phase1-credentials:new:217-288]] |
| `IntegrationService` and its private `createExecutorDatabase()` helper | Initialize Executor-owned tables, adapt Drizzle to FumaDB and serialize whole SQLite transactions. Adapt the spec loader into an Effect HTTP layer only for Google's Discovery adapter; ordinary tool HTTP stays unchanged. Construct the credential provider, cache user-bound Executors and drain operations on shutdown. [[phase1-adapter:new:21-99]] [[phase1-integrations:new:51-94]] [[phase1-integrations:new:212-279]] |

**Run an operation:** instances are created lazily, not for every user at control-plane startup. Concurrent first calls for the same user await the same initialization promise. Later calls reuse the instance; a failed initialization is removed from the cache so a later call can retry initialization.

```callstack
+Run an internal operation with IntegrationService.withUser(userId, operation) [[phase1-integrations:new:112-125]]
+├── reject if shutdown has started; track accepted work [[phase1-integrations:new:116-124]]
+├── reuse or create the user's Executor [[phase1-integrations:new:127-145]]
+│   ├── bind tenant, subject and credential provider to userId [[phase1-integrations:new:147-160]]
+│   └── install missing Google presets; skip existing ones [[phase1-integrations:new:170-210]]
+└── run the supplied Executor operation and return its result or an error [[phase1-integrations:new:141-145]]
```

```ts
// Existing internal API: no HTTP request and no workspace routing yet.
const catalog = await integrations.withUser(userId, (executor) =>
  executor.integrations.list(),
);
if (catalog instanceof Error) return catalog;
// Use the catalog. Executor, not Halo, implements the query and owner filtering.
```

**Verify the boundary:** `ControlPlane.test.ts` starts the complete host and exercises catalog/policy isolation, encrypted credential use after restart, draining and failed-start cleanup. Tests supply Google Discovery text through `getOpenAPISpec`; the restarted Executor calls a real loopback fixture API through its normal HTTP client, with the saved token. `CredentialService.test.ts` checks persistence, isolation and decryption errors through the plain promise API. Neither suite requires workspace routing or real OAuth, which belong to later phases. `withUser`, caching and immediate decline behavior are unchanged by this refactor.

**Enablement and recovery:** Store a canonical base64 encoding of 32 random bytes under the fixed Secret Manager name `halo-control-plane-integration-credential-key` in project `halo-relay`. The name lives in code; there is no environment-variable override. Application startup always reads this secret, and a missing, unreadable or malformed secret fails startup. The control-plane principal needs access to it. Never replace the key casually: restoring encrypted credential rows requires the original key. Back up both local database files (or the PostgreSQL database) and preserve access to that key. Rotation and production provisioning are not implemented here; changing the key makes existing credentials fail decryption. No secrets were provisioned.

**Evidence:**

- `pnpm --filter @get-halo/control-plane exec vitest run test/ControlPlane.test.ts src/credentials`: **27 passed, 2 skipped**. The pre-existing skipped cases require an inference API key and a GCP trace bucket.
- The restart/catalog/credential test also passed against disposable PostgreSQL 15. After closing and reopening the whole ControlPlane, Executor used the saved encrypted token on a fixture API request. Google Discovery fetches were stubbed at Executor's HTTP boundary; real Google OAuth was not exercised.
- Tests cover concurrent first-use coalescing, distinct users' catalogs/policies/credentials, wrong-key and tampered-owner rejection, draining work, rejecting calls after close, and failed-start port reuse.
- Temporary adapter probes on SQLite and PostgreSQL forced a transaction to roll back while another write was queued: the rolled-back row was absent and the independent row committed. Probe code and disposable data were removed after verification.
- `pnpm run check-affected`: **46 successful tasks** before the checkpoint; **13 successful affected tasks** after the boundary refactor. No product UI changed in this phase.

At the Phase 1 checkpoint, workspace consumers still used the existing backend and instances remained cached until shutdown. Phase 2 below adds the remote API and bounds cache and request lifetimes; workspace consumer routing remains unchanged.

### ✅ Phase 2: Expose authenticated discovery and invocation

**Today**

Runtime credentials identify workspaces, but no integration RPC surface exists.

**Proposed**

Add three runtime-authenticated procedures to the existing control-plane RPC transport: `integrations.search`, `integrations.describe` and `integrations.invoke`. This phase makes the internal service callable by a workspace VM; it does not route the agent through it yet. Production workspace routing remains Phase 5.

#### Authenticate the workspace before choosing an Executor

The existing browser/desktop RPC middleware loads a user session. Workspace runtime tokens deliberately do not count as those sessions. The new `loadRuntime` middleware reuses WorkspaceService's current-token verification. `authenticateRuntimeOwner` is now accessible to the router and returns `{ workspaceId, ownerUserId }`; the middleware does not independently validate an API key or trust IDs in a request body. The public identity endpoint still returns only workspace ID.

```mermaid
flowchart LR
  W[Send workspace runtime token] --> R[Receive integration RPC]
  R --> A[Verify token and current workspace key]
  A -->|invalid or rotated| X[Return UNAUTHORIZED]
  A -->|valid| I[Derive workspaceId and ownerUserId]
  I --> S[Call IntegrationService]
  S --> E[Select owner-bound Executor via withUser]
  E --> D[Read that owner's persistent state]
  %% ref node:R [[phase2-router:new:134-145]]
  %% ref node:A [[phase2-router:new:52-67]]
  %% ref node:E [[phase2-service:new:273-290]]
```

The workspace supplies the bearer token, query, tool address and arguments. It never supplies authoritative `userId`, tenant or owner fields. Rotation rejects subsequent requests using the old key; it cannot undo an operation already accepted with that key.

#### API outline: search summaries, describe schemas, invoke one tool

The API below summarizes the implemented shared contract. TypeBox validates the JSON input through Standard Schema, including required fields, limits, and rejection of extra owner fields. The existing `/rpc` transport and protocol compatibility checks remain in use. These additive procedures keep protocol version 3; no existing request or response changed.

```ts
type JsonValue = null | boolean | number | string | JsonValue[] |
  { [key: string]: JsonValue };

type ToolSummary = {
  address: string;      // Executor's opaque, connection-qualified address
  integration: string;
  connection: string;
  name: string;
  description: string;
};

// All three require Authorization: Bearer <workspace-runtime-token>.
interface IntegrationRpc {
  search(input: {
    query: string;
    integration?: string;
    limit?: number;     // default 50, accepted range 1–100
  }): Promise<{ tools: ToolSummary[]; truncated: boolean }>;

  describe(input: {
    address: string;
  }): Promise<ToolSummary & {
    inputSchema?: JsonValue;
    outputSchema?: JsonValue;
    schemaDefinitions?: JsonValue;
    requiresApproval?: boolean; // a hint, not authorization to execute
  }>;

  invoke(input: {
    address: string;
    arguments: { [key: string]: JsonValue };
  }): Promise<InvocationOutcome>;
}

type InvocationOutcome =
  | { status: "completed"; result: JsonValue }
  | { status: "blocked" }
  | { status: "approval_required" }
  | { status: "connection_required" }
  | { status: "failed"; code: "tool_failed" | "unsupported_interaction" |
      "outcome_unknown"; message: string };

// Host-facing methods receive verified identity separately from wire input.
// Existing withUser remains the internal SDK bridge.
const identity = await workspace.authenticateRuntimeOwner(headers);
if (identity instanceof Error) return unauthorized();
return await integrations.search({ ...input, userId: identity.ownerUserId, signal });
```

Transport errors distinguish unauthenticated requests, invalid input, invisible/missing tools and an unavailable service. Internal service methods continue returning `Value | Error`; the RPC boundary translates those into protocol errors. Invocation outcomes describe an accepted operation, not authentication failures. Preserve provider tool-error status in the normalized result instead of treating an error payload as success. Do not serialize SDK instances, raw error causes, provider handles or stored credentials.

| Operation | Delegate to Executor | Halo's responsibility |
| --- | --- | --- |
| `search` | `tools.list({ query, integration })`; native search is case-insensitive substring matching, not semantic ranking | Bound the result count and project compact summaries. Keep Executor's default blocked-tool filtering. Exclude static/configuration tools and non-integration plugins. |
| `describe` | Resolve the visible tool and call `tools.schema(address)` | Return its JSON schema without execution. Treat another user's address like a missing tool. Do not infer a connection from an integration name. |
| `invoke` | Resolve the permitted integration tool, then `execute(address, args)` | Validate the JSON envelope, preserve the OpenAPI plugin's argument checks and Executor policy checks, normalize the outcome, and add no Halo retry. Executor does not perform universal JSON Schema validation. |

An address is an identifier, not a capability. Apply the integration-only restriction to describe and invoke as well as search; hiding management tools from search alone would still let a caller invoke a guessed address. Specifically, do not expose Executor's policy, provider, connection-management or artifact tools through this API.

**SDK retry caveat:** Executor 1.6.0 may retry once after a structured 401 connection rejection if OAuth refresh succeeds. Halo calls `execute` once and does not replay lost responses, timeouts, or transport failures. This is not an exactly-once provider-request guarantee.

```mermaid
sequenceDiagram
  participant W as Workspace caller
  participant R as Runtime-auth RPC
  participant S as IntegrationService
  participant E as Owner-bound Executor
  participant P as External API
  W->>R: search(query), bearer token
  R->>R: Authenticate and derive owner
  R->>S: search(ownerUserId, query)
  S->>E: tools.list(filter)
  E-->>W: Integration tool summaries through S and R
  W->>R: describe(address), bearer token
  R->>S: describe(verified owner, address)
  S->>E: Resolve visible tool and read schema
  E-->>W: JSON schema through S and R
  W->>R: invoke(address, args), bearer token
  R->>S: invoke(verified owner, address, args)
  S->>E: Validate target and call execute once
  E->>E: Check arguments and evaluate native policy
  alt Allowed
    E->>P: Send integration request using stored credentials
    P-->>E: Tool response
    E-->>W: Normalized result through S and R
  else Blocked or approval required
    E-->>W: Non-executed outcome through S and R
  end
  %% ref node:R [[phase2-router:new:134-168]]
  %% ref node:S [[phase2-service:new:131-188]]
  %% ref edge:12 [[phase2-service:new:204-220]]
```

#### Keep Phase 2 separate from OAuth and approval UX

Phase 2 operates on connections prepared through the internal service in tests. Phase 3 adds OAuth and connection setup; automatic approval is now initialized per user by the service. Phase 4 exposes setup metadata to agent cards; it no longer creates exact one-use grants. `approval_required` in Phase 2 has no approval-request ID and cannot be approved through this API. Only Executor's top-level `ElicitationDeclinedError` becomes approval-required. Other invocation failures are conservatively reported as outcome-unknown; raw SDK errors and credentials do not cross RPC.

```mermaid
flowchart TD
  A[Accept invoke request] --> B[Resolve visible integration tool]
  B --> C[Evaluate Executor policy]
  C -->|block| D[Return blocked]
  C -->|needs consent| E[Decline immediately; return approval_required]
  C -->|allow| F[Call Executor execute once]
  F -->|known response| G[Return normalized tool result]
  F -->|response lost after dispatch| H[Report outcome unknown; do not replay]
  E -. Phase 4 .-> I[Show connection setup card when applicable]
```

RPC passes its AbortSignal into IntegrationService, which applies a 30-second operation deadline, including waiting for lazy initialization. Cancelling after an external write was dispatched does not prove that write was cancelled. If the transport itself is lost, the caller must also treat the outcome as unknown. The per-user cache holds at most 100 instances; a new owner replaces an idle instance, never one with active work or initialization. Concurrent callers still share initialization. Initialization has bounded SDK steps and continues for other callers when one request cancels. Shutdown drains operations and initialization before closing the database.

```callstack
 Serve control-plane HTTP [[apps/control-plane/src/server/controlPlaneHttp.ts#serveControlPlaneHttp]]
+└── handle integrations RPC through the existing transport [[phase2-router:new:134-168]]
+    ├── authenticate runtime token and derive owner [[phase2-router:new:52-67]]
+    ├── validate JSON input and enforce integration-only tool access [[phase2-contract:new:123-164]]
+    └── call IntegrationService for that owner [[phase2-service:new:131-155]]
+        ├── delegate search and schemas to Executor [[phase2-service:new:141-182]]
+        └── execute one invocation and normalize its outcome [[phase2-service:new:196-263]]
```

**Historical Phase 2 verification (before automatic approval):** The canonical ControlPlane fixture uses a real loopback integration API. Search → describe → invoke returns the expected schema and write result. One allowed call sends one mutation request; unknown arguments, blocked policies, and missing approval send none. Missing/browser/desktop credentials, forged owner fields, static management addresses, another owner's tool, and rotated runtime keys are rejected. Provider errors stay failed outcomes. A dropped response produces outcome-unknown and one outbound request. Cancelling a pending call closes the outbound API request. Existing workspace routing is unchanged.

**Historical checks after MCP (before automatic approval; not current verification):** `pnpm --filter @get-halo/control-plane exec vitest run test/ControlPlane.test.ts`: 25 passed, 2 skipped (external inference and GCP tracing). `pnpm --filter @get-halo/control-plane exec vitest run src/credentials/CredentialService.test.ts`: 4 passed. `pnpm run check-affected`: 46 tasks passed. No live Google OAuth or production API writes were used.

#### Completed MCP backend addition

IntegrationService now installs Executor's `mcpPlugin()` alongside OpenAPI and permits dynamic tools from both plugins through search → describe → invoke. Remote HTTP/SSE transports are supported by the plugin; stdio remains disabled to prevent user-supplied processes in the control plane. No new credential store or MCP-specific policy engine is added.

```callstack
 Instantiate IntegrationService [[apps/control-plane/src/integrations/IntegrationService.ts#IntegrationService]]
+├── install OpenAPI and remote MCP plugins [[apps/control-plane/src/integrations/IntegrationService.ts#IntegrationService.create]]
+└── serve runtime-authenticated search, describe and invoke
+    ├── resolve the caller's connection-qualified MCP tool
+    ├── evaluate Executor policies and resolve saved credentials
+    └── invoke the remote MCP server and preserve its result content
```

The earlier MCP checkpoint's HTTP fixture verified no-auth and Bearer-key MCP connections, discovery, input schema, response content, user isolation, approval preventing dispatch, and no stdio subprocess execution. SSE and OAuth MCP flows have not been exercised here. Registration is still internal setup; Phase 3 adds the user-facing path. The Phase 2 patches below preserve the pre-MCP checkpoint; the current local implementation snapshot follows them. Current verification is recorded in Phase 3.

### ✅ Phase 3: Connect accounts with automatic native approval

**Today**

The workspace owns OAuth callbacks, tokens and connection status. The new control-plane backend can use internally prepared OpenAPI and MCP connections, but has no public setup or approval flow.

**Proposed**

Move setup, callbacks and credential ownership to the control plane. After authentication succeeds, the connection is ready with automatic approval from the native tenant-scoped org wildcard policy. Do not add a pre-connection block, an awaiting-approval gate or approval preference controls. Phase 3 delivers the backend and browser setup surface; Phase 4 connects it to agent-result cards, and Phase 5 routes normal workspace tool calls.

#### Implemented first: initialize the native approval fallback

The user-authenticated `integrations.connections()` RPC remains and lists address, integration, name and optional account label. Runtime tokens cannot use it. Cookie requests must carry the control plane's Origin; desktop bearer sessions remain supported. `setConnectionApproval` and `approvalPreference` metadata have been removed; no approval-changing RPC remains.

IntegrationService seeds a persisted native `org` policy with pattern `*` and action `approve` while initializing each user's Executor, before registering presets. It checks for an existing matching rule first. The custom preference plugin, queue and PostgreSQL advisory lock are deleted. No custom SQL policy schema or parallel evaluator is added, and explicit restrictive native policies remain authoritative.

```callstack
 Initialize per-user Executor [[apps/control-plane/src/integrations/IntegrationService.ts#IntegrationService.create]]
+├── bind tenant and subject to userId
+├── list native persisted policies
+├── create org wildcard approve only if absent [[apps/control-plane/src/integrations/IntegrationService.ts#IntegrationService.create]]
+└── retain declining elicitation handler and register integration presets
```

**Canonical test passed:** `automatically approves MCP, OpenAPI and Google connections across restart` in [[apps/control-plane/test/ControlPlane.test.ts]] uses the real HTTP fixture, remote MCP, custom OpenAPI and bundled `google_gmail` with local Discovery/OAuth fixtures. Reads and repeated writes complete without opt-in, another connection is also approved, explicit user blocks still prevent calls, and recreating the host preserves six connections and one native policy. Writes for all three families complete after restart without reseeding.

**Historical automatic-approval slice evidence:** the control-plane/credential command reported **30 passed, 2 skipped**, and `check-affected` reported **46 successful tasks** before the setup and UI additions. Current verification is recorded under Delivery state below.

**Implemented now:** `catalog`, `startSetup`, `setup`, `submitSetup`, `cancelSetup`, `registerOpenAPI` and `registerMcp`. Registration is human-authenticated RPC only; there is no registration form. IntegrationService stores durable setup SQL and atomically claims submission, cancellation and callback consumption. The native HTTP callback is `/api/integrations/oauth/callback`; its stored state determines the initiating user, not the current browser identity. URL validation rejects private networks and redirects, including checking DNS results at the actual socket lookup. Local fixture URLs require an explicit test exception. Disconnect has no endpoint or UI yet.

#### Follow the connection from setup to ready

1. **Choose the integration.** Select a bundled Google integration, register an OpenAPI spec, or register a remote MCP endpoint. MCP registration uses `executor.mcp.addServer`; OpenAPI uses `executor.openapi.addSpec`. These register catalogs, not authorized accounts. Validate remote URLs and restrict access to private networks/cloud metadata before fetching user-supplied endpoints, including redirects. Local test fixtures need an explicit test-only exception.
2. **Start setup without connection-specific policy changes.** Derive the user from authentication and persist setup progress. Per-user initialization ensures the org fallback exists. Let Executor create/name the connection normally and record its actual returned identity. Do not install a connection-specific require-approval or block rule.
3. **Authenticate to the provider.** For OAuth, `executor.oauth.start` returns an authorization URL and state, or an immediate connection for client-credentials grants. Use the control plane's public callback URI and server-side OAuth client configuration. For API-key/header auth, collect secrets in an authenticated HTTPS form on the control plane and call `executor.connections.create`; never route secrets through model arguments, chat, logs or integration metadata. No-auth MCP connections use the same automatic approval fallback after creation.
4. **Complete OAuth.** Route the callback state to its initiating user/setup record and call that user's `executor.oauth.complete({state, code})`. Never choose an owner from a query parameter or the browser's current account. Executor owns state expiry, PKCE, token exchange and connection minting. Halo records completion/error for polling. Reject mismatched, expired or consumed states. Setup cancellation uses `executor.oauth.cancel(state)` where a flow is still pending; it does not introduce a connection-blocking policy.
5. **Show the ready connection.** The browser displays integration name, connection name and account label when returned. It does not claim to display granted scopes or provider endpoint. There is no approval preference or second consent step; explicit restrictions still apply.
6. **Use, refresh or disconnect (remaining consumer work).** Executor owns credential resolution/refresh, but normal workspace invocation routing remains Phase 5. Disconnect still needs a separate endpoint and UI. Nothing automatically resumes the earlier script.

```mermaid
sequenceDiagram
  participant W as Workspace agent
  participant U as User browser
  participant C as Control plane
  participant E as Executor
  participant P as OAuth or MCP provider
  W->>C: Start setup for an integration
  C-->>W: Return setup ID and browser URL
  U->>C: Open authenticated setup page
  C->>E: oauth.start with public callback
  E-->>U: Authorization URL
  U->>P: Authenticate and grant OAuth scopes
  P->>C: Callback with state and code
  C->>E: Resolve initiating user; oauth.complete
  E->>P: Exchange code and store credentials
  C-->>U: Connected; tools automatically approved subject to restrictions
  W->>C: Poll setup status
  C-->>W: Ready; do not replay previous script
  %% ref node:C [[automatic-approval:new:229-268]]
  %% ref edge:3 [[automatic-approval:new:338-414]]
  %% ref edge:6 [[automatic-approval:new:511-560]]
  %% ref edge:10 [[remote-connections:new:305-338]]
```

#### Keep the public API semantic and plain TypeScript

These Halo APIs are implemented in the shared contract and existing RPC router. Executor has no native setup-status endpoint, so IntegrationService owns `halo_integration_setup`: user, integration, connection name, serialized non-secret setup data, status, expiry and OAuth-state correlation. No approval preference is stored. Executor still owns OAuth sessions, connections and policies; CredentialService owns encrypted tokens. Protocol adaptation and Effect remain inside IntegrationService.

```ts
type SetupState =
  | "awaiting_credentials"
  | "authorizing"
  | "expired"
  | "ready"
  | "cancelled"
  | "failed";

// Human session or authenticated workspace runtime; derive owner server-side.
startSetup({ integration, connectionName? }): Promise<{ setupId: string; setupUrl: string }>;
setup({ setupId }): Promise<{
  status: SetupState;
  connection?: { name: string; accountLabel?: string };
  message?: string;
}>;
cancelSetup({ setupId }): Promise<void>;

// Human session only; verify Origin/CSRF protection. Never agent-exposed.
submitSetup({ setupId, template, values }): Promise<{ authorizationUrl?: string }>;
registerOpenAPI({ name, slug, url }): Promise<void>;
registerMcp({ name, slug, endpoint, auth }): Promise<void>;
// Disconnect is not implemented.
// The OAuth callback validates stored state; it is not a runtime RPC.
```

API-key fields come from Executor authentication methods; returned status never contains secrets. MCP OAuth uses native discovery and supported dynamic registration, not an assumption that every server supports DCR. Providers without DCR need a matching configured client. First-party Google now uses the existing control-plane auth client ID and secret from server configuration. Production must configure the public integration callback URI and required Google scopes before live testing; sign-in configuration alone is not proof that integration consent works.

#### Keep storage and failure ownership explicit

- DatabaseService supplies SQL access. IntegrationService owns the Executor adapter and Halo setup coordination. OAuth sessions/PKCE and policies live in Executor's SQL schema; tokens and client secrets use CredentialService's encrypted storage. The encryption key remains in GCP Secret Manager. No additional encryption-key environment variable is introduced.
- Executor persists OAuth sessions with a 15-minute expiry. Halo's durable correlation/status record makes the same unexpired flow resumable after restart; expired flows require a new start. Do not promise seamless completion if a provider consumes a code just before a crash.
- Verify native rule ordering and tenant isolation. Independent org/user restrictions remain authoritative; report restrictions without changing them to make automatic approval succeed.
- OAuth completion, cancel and disconnect can race. Serialize or transactionally claim setup transitions and test recovery. Setup cancellation does not install a block policy or remove the tenant fallback.

```callstack
-Start OAuth in the workspace and store local credential files
+Start setup with IntegrationService.startSetup [[automatic-approval:new:229-268]]
+├── validate catalog membership and persist owner-bound setup [[automatic-approval:new:234-263]]
+├── claim submission and start OAuth or create a connection [[automatic-approval:new:294-414]]
+├── claim callback state and complete with its stored owner [[automatic-approval:new:511-560]]
+├── reject private DNS results and redirects at the socket [[automatic-approval:new:618-722]]
+└── render authenticated method/secret form outside workspace provider [[setup-route:new:37-57]] [[setup-page:new:186-220]]
```

**Browser surface implemented:** `/integrations/setup/:setupId` is behind `Authentication`, outside the workspace `ApiProvider`. It offers method selection and password-type secret fields, explains automatic write approval, and shows loading/pending, authorizing, ready, cancelled, expired and failed states. The actual compiled app was exercised through the canonical fixture; see Delivery state for scope and limits.

### ✅ Phase 4: Surface connection readiness in agent results

**Today**

Phase 3 owns connection setup and automatic native approval. Workspace results still use the legacy per-invocation approval model.

**Proposed**

Return structured setup metadata when an integration needs connection. Connected tools use automatic native approval without a preference card. If an explicit restriction requires approval or blocks invocation, report that outcome without dispatch or a bypass offer. No one-use approval endpoint is added in this iteration. Unsupported plugin elicitations remain declined.

```callstack
 Keep existing local action approval behavior
+Intercept explicit connection card and native oauth.start [[remote-runtime:new:995-1016]]
+├── emit a control-plane ConnectionRequest rather than an action approval [[remote-runtime:new:1003-1016]]
+├── start backend setup and publish connecting [[remote-connections:new:248-304]]
+├── open a browser tab or Electron external URL without loopback [[setup-web-host:new:189-199]] [[setup-web-host:new:219-223]] [[setup-desktop:new:133-160]]
+├── poll backend status and publish terminal connection state [[remote-connections:new:305-338]]
+└── cancel pending setup through the backend [[remote-connections:new:223-234]]
+Collect remote invocation connection failures in Phase 5's per-exec context [[packages/workspace-server/src/agent/runtime/ToolRuntime.ts#ToolRuntime.dispatch]]
```

Verify immediate connection cards, status updates, automatically approved ready connections, restricted/cancelled states and agent continuation without automatic replay. Background extensions receive native restriction or connection-not-ready outcomes without a card. No one-use grants, approval preferences, per-tool choices or allow-once UI are planned.

**Implemented:** `ConnectionRequest` includes a control-plane variant. Explicit `tools.halo.showConnectionCard` and intercepted native `oauth.start` produce remote connection cards rather than action approvals. ConnectionService starts, polls and cancels backend setups and publishes connecting/connected/cancelled/expired/failed status. WebHost reserves a tab and opens the setup URL; Electron opens it directly without a loopback callback. Legacy local approvals and OAuth flows remain. Phase 5 removes the startup remote-catalog fetch; explicit setup requests still reach backend catalog-membership validation, including registrations made after startup.

**Completed with Phase 5:** remote `connection_required` includes server-derived integration/connection identity. ToolRuntime collects it into the same exec result consumed by the existing card projection. After connection setup the agent receives the existing readiness notification and decides whether to make a new call; no script is replayed. Live desktop interaction remains unverified in this orb.

### ✅ Phase 5: Route workspace integration calls through the client

**Today**

The host supplies remote catalog/setup methods, but not remote tool invocation. `ToolRuntime.executeCode` runs JavaScript through the workspace Executor engine; `invokePath` uses a separately constructed Executor invoker for extensions. `search`, `describe` and the engine's built-in discovery still see the workspace catalog. Production workspace integrations are disabled, so successful remote setup does not yet make those tools callable from an agent or extension.

**Proposed**

Keep JavaScript and local tools on the workspace. Add remote discovery and invocation to the existing runtime-authenticated host client, and route both sandbox and extension calls through the same ToolRuntime dispatch decision. Only an individual integration call crosses to the control plane. Translate a missing connection into the existing chat card as part of the same exec result, without waiting for the model to call `showConnectionCard`.

This phase does **not** replace the sandbox with Pi codemode, remove legacy storage, migrate connections, expose Executor management APIs, or add action-approval UI. Existing local capability checks and approval behavior stay intact. Connected integrations use the native automatic-approval policy already installed in Phase 3; explicit restrictions still return an error.

**Implementation:** `RemoteIntegrationTools` is a plain-TypeScript host capability, not a new service. The host reuses one RPC client for tool and setup operations. `ToolRuntime.dispatch` routes both the sandbox and extension invoker, and its per-execution collector deduplicates connection requests. Discovery returns source/truncation/unavailability metadata, and remote descriptions retain schema definitions and SDK TypeScript. Protocol **4** requires connection identity on connection failures. Same-connection OAuth reuses stored client/template bindings; API-key replacement uses the pinned SDK's credential upsert. The sections below retain the design rationale; these APIs are now implemented.

```callstack
 Supply remote tool operations from the executable host [[apps/workspace-server/src/main.ts]]
+├── reuse runtime-authenticated RPC transport
+└── inject RemoteIntegrationTools [[phase5-tools:new:10-23]]
 Route sandbox and extension calls in ToolRuntime [[packages/workspace-server/src/agent/runtime/ToolRuntime.ts#ToolRuntime.dispatch]]
+├── preserve local tool execution and local approvals
+├── forward only integration calls to the control plane
+└── collect connection-required results without replaying code [[packages/workspace-server/src/agent/runtime/ToolRuntime.ts#ToolRuntime.executeCode]]
 Reconnect after the user opens setup [[apps/control-plane/src/integrations/IntegrationService.ts#IntegrationService.submitSetup]]
+├── validate the original user-owned connection and authentication binding
+├── replace credentials using Executor's existing APIs
+└── publish ready through existing ConnectionService polling [[packages/workspace-server/src/agent/runtime/ConnectionService.ts]]
```

#### 5A. Supply remote tool operations from the workspace host

Extend the existing host boundary rather than introduce another service or HTTP transport. The executable host creates one `ControlPlaneClient`, supplies a narrow integration-tools capability to ToolRuntime, and continues supplying the setup capability to ConnectionService. Keep ownership of the two interfaces with their consumers; neither consumer receives browser credentials, raw database access or an Executor instance.

```ts
// Implemented plain-TypeScript host capability.
// Wire payloads reuse the existing shared contract. Errors are returned as values.
interface RemoteIntegrationTools {
  search(input: { query: string; integration?: string; limit?: number },
    signal?: AbortSignal): Promise<{
      tools: IntegrationTool[];
      truncated: boolean;
    } | Error>;
  describe(input: { address: string },
    signal?: AbortSignal): Promise<IntegrationToolSchema | Error>;
  invoke(input: { address: string; arguments: Record<string, IntegrationJson> },
    signal?: AbortSignal): Promise<IntegrationInvocation | Error>;
}
```

Use the configured runtime origin/token and existing protocol header in [[apps/workspace-server/src/main.ts]]. The control plane derives the owner from the validated runtime token in [[apps/control-plane/src/server/controlPlaneRpcRouter.ts]]; never accept a caller-supplied user ID. With no runtime configuration, operate locally and report remote integration support as unavailable. Do not substitute browser authentication or read a developer's credentials.

Forward cancellation into the RPC and IntegrationService. Do not copy the setup client's ten-second timeout onto arbitrary tool execution. Use the caller's execution lifetime; cancellation or a lost response after dispatch does not prove that an external write was cancelled. Never automatically retry invocation. Startup and ordinary file/shell calls must not wait on a remote catalog fetch.

#### 5B. Route discovery and calls at the existing sandbox boundary

The engine passes a tool invoker into `CodeExecutor.execute`; `withToolActivity` already wraps it. Add the dispatch decision there, inside activity reporting, and reuse that decision from `invokePath` and other direct ToolRuntime entry points. Fall back to the original local invoker for local calls, preserving its elicitation handling. Do not call the new dispatcher recursively from the fallback. Keep any necessary Effect conversion at this existing Executor adapter seam, not in the application host.

```callstack
 Run agent JavaScript with ToolRuntime.executeCode [[packages/workspace-server/src/agent/runtime/ToolRuntime.ts#ToolRuntime.executeCode]]
 └── execute code in the existing workspace QuickJS engine
     └── record tool activity with withToolActivity [[packages/workspace-server/src/agent/runtime/ToolRuntime.ts#withToolActivity]]
-        └── invoke every path with the workspace Executor invoker
+        └── dispatch the requested path through ToolRuntime
+            ├── search or describe local and remote tools
+            ├── invoke a local tool with the original invoker and local approval checks
+            └── invoke an integration through the runtime-authenticated client
+                └── resolve the owner and execute with IntegrationService.invoke [[apps/control-plane/src/integrations/IntegrationService.ts#IntegrationService.invoke]]
```

```callstack
 Receive an extension tool request [[packages/workspace-server/src/extensions/extensionsRouter.ts#extensionToolRouter]]
 └── call ToolRuntime.invokePath [[packages/workspace-server/src/agent/runtime/ToolRuntime.ts#ToolRuntime.invokePath]]
-    └── invoke only through the separate workspace Executor invoker
+    └── reuse the same discovery/local/remote dispatch decision
+        └── return a checked ToolResult without opening a browser or emitting a chat card
```

**Address convention (proposed):** reserve `integrations.` for remote tool paths. Discovery returns `path = "integrations." + tool.address`; `tools[path](args)` is the supported dynamic invocation form. Strip exactly that prefix before sending the opaque address to the control plane. Do not split it to guess the provider, account or tool name. This avoids a custom integration shadowing `files`, `shell`, `search` or other local names, and lets a saved path work after workspace restart without a discovery cache. Reject a local plugin attempting to claim the reserved prefix. Display names come from returned metadata, not from this routing prefix.

Remote-qualified paths never fall back to local tools on an error. Unknown local paths remain local not-found errors. Preserve old local integration paths during the transition; discovery labels the remote ones explicitly. This is a new remote namespace, not a migration of stored extension code.

**Discovery:** intercept `search` and `describe.tool` in the sandbox as well as the corresponding direct ToolRuntime methods. Calling only the public `runtime.search()` method is insufficient: the current engine has its own discovery invoker. Retain the local integration-list/setup behavior needed for explicit connection requests, and make its remote catalog view fresh enough to include integrations registered after workspace startup. Do not expose control-plane management tools through a catch-all remote proxy.

Implemented unified discovery result:

```ts
type SearchResult = {
  tools: Array<{
    path: string;
    name: string;
    description: string;
    source: "workspace" | "control-plane";
  }>;
  truncated: boolean;
  unavailableSources: Array<"control-plane">;
};
// tools.search({ query, limit?, source?: "workspace" | "control-plane" })
// tools.describe.tool({ path })
```

Search the requested sources, return local results first in a stable order, deduplicate by path and apply the requested total limit. Bound remote requests to the existing 1–100 limit and propagate remote truncation; do not imply that a bounded search enumerates every available tool. An unqualified search can return usable local matches plus `unavailableSources: ["control-plane"]`; a remote-only search must return a checked failure on an outage, not an empty catalog. Local-only discovery does not contact the control plane. Update the agent-facing discovery descriptions/examples and assertions to match this result shape.

Describe local paths as today. Describe remote paths with `IntegrationToolSchema`, preserving input/output JSON Schema and `schemaDefinitions`; extend the remote DTO with optional SDK-generated TypeScript descriptions to preserve the current description surface where Executor supplies them. Do not write a second schema-to-TypeScript generator. `requiresApproval` remains a hint, not a workspace authorization check. Do not turn `listToolPaths` into a silent, truncated remote inventory: keep its local-inventory role explicit and direct remote discovery through search.

#### 5C. Translate invocation outcomes and automatically surface connection setup

Extend the existing `connection_required` outcome in [[packages/shared/src/controlPlaneContract.ts]] with server-derived connection identity. IntegrationService already resolves the tool before invoking it; derive these fields from that resolved tool, not arbitrary invocation arguments. Keep this wire metadata independent of the client UI's `ConnectionRequest` type.

```ts
// Implemented replacement for the metadata-free connection_required union member.
type ConnectionRequired = {
  status: "connection_required";
  integration: string;
  connectionName?: string;
};

// Pseudocode inside the shared dispatcher, not a new service.
const outcome = await remote.invoke({ address, arguments: args }, signal);
if (outcome instanceof Error) return unknownOutcomeFailure(outcome);
if (outcome.status === "completed") return toolSuccess(outcome.result);
if (outcome.status === "connection_required") {
  // Present only for agent exec; deduplicate within this execution.
  executionContext?.collectConnectionRequest?.({
    kind: "control-plane",
    integration: outcome.integration,
    connectionName: outcome.connectionName,
  });
}
return toolFailure(outcome); // Preserve a machine-readable status/code.
```

Validate remote arguments as JSON objects before sending them. Convert success to the existing SDK `ToolResult` success shape and failures to its checked error shape. Do not represent `{status: "blocked"}` as successful tool data. Preserve `blocked`, `approval_required`, `connection_required`, provider failures and `outcome_unknown` as distinguishable outcomes; activity must mark them failed. A transport failure after invoking is conservatively `outcome_unknown`, not safe-to-retry.

```mermaid
sequenceDiagram
  participant A as Agent exec on workspace
  participant R as ToolRuntime
  participant C as Control-plane IntegrationService
  participant E as User-bound Executor
  participant U as Existing connection card
  A->>R: Invoke discovered remote path
  R->>C: Invoke opaque address with runtime authentication
  C->>E: Execute tool under native policy
  alt Connected and allowed
    E-->>C: Return tool data
    C-->>R: completed
    R-->>A: Return successful ToolResult
  else Connection required
    E-->>C: Return connection failure
    C-->>R: connection_required plus resolved identity
    R-->>A: Return checked failure; do not wait for sign-in
    R->>U: Include connectionRequests in the same exec result
    Note over A,U: No extra model turn to request a card; no script replay
  else Explicit restriction
    E-->>C: Block or request approval
    C-->>R: blocked or approval_required
    R-->>A: Return checked failure without approval UI
  end
  %% ref node:R [[packages/workspace-server/src/agent/runtime/ToolRuntime.ts]]
  %% ref node:C [[apps/control-plane/src/integrations/IntegrationService.ts#IntegrationService.invoke]]
  %% ref node:U [[packages/web/src/main/agent/ExecutorConnectionCard.tsx]]
```

Collect connection requests in the per-execution context, not service-global state. Keep them even if JavaScript handles the tool failure or omits `return`. Feed the existing `ToolInputRequiredError` → `createExecTool` result details → `sessionView` projection so the existing card renders when that exec completes. This does not promise a mid-script card while other JavaScript is still running. Deduplicate repeated requests for the same integration/connection within an exec. Keep simultaneous threads isolated.

The card's Connect action starts setup only after the user's click. Successful setup sends the existing connection-state notification; it does not rerun a script or resume a suspended invocation. The agent can make a new call explicitly. If no connected tool exists to discover in the first place, keep the catalog plus explicit `showConnectionCard` path; do not invent addresses or map arbitrary not-found errors to setup requests. Revoked credentials or insufficient scopes can produce the automatic-card path after a tool is resolved.

**Implemented setup follow-through:** `startSetup` resolves the supplied connection name under the authenticated user's tenant and records its existing template/client bindings privately. `submitSetup` revalidates them and claims only one active authorization for that connection. New-connection flows still reject duplicates. OAuth uses `oauth.start` with the stored client and identity, omitting `newConnection`, followed by the existing callback/complete flow. API keys use `connections.create` with the existing identity and replacement credentials, preserving the account label. This is the SDK **1.6.0** upsert behavior; newer Executor source rejects duplicates, so revisit it before upgrading. No connection is deleted/recreated and no tool is replayed. Tests verify invocation through the original address after replacement. Ordinary token refresh stays Executor's responsibility.

Background extensions get the same checked failure but no collector, card, browser launch or approval wait. The extension can retry explicitly after a user connects elsewhere. Local action approvals remain separate and unchanged.

#### Delivery slices and verification

Implementation was split across these boundaries:

1. **Add the remote capability and result metadata.** Extend the host wiring, shared DTO and IntegrationService's missing-connection mapping. Keep existing setup calls intact. Review protocol compatibility: the new metadata must not be assumed present from an older control plane; use the existing protocol-version mechanism if the contract is made required.
2. **Connect one dispatcher to both consumers.** Add remote address handling, unified discovery and schema descriptions; preserve local fallback, activity and cancellation. Update descriptions/prompts in [[packages/workspace-server/src/agent/workspacePrompt.ts]] and ToolRuntime rather than teaching only tests the new shape.
3. **Complete automatic cards and run consumer checks.** Extend the existing exec result collector and the same-connection reauthorization path; test agent and extension behavior together, then exercise the running UI. Mark Phase 4 complete only when the invocation-driven card works, not merely because explicit setup already does.

Extend existing canonical fixtures/tests in [[apps/control-plane/test/ControlPlane.test.ts]], [[packages/workspace-server/test/workspace.test.ts]] and [[packages/workspace-server/test/oauth.test.ts]]. Use public RPC/tool surfaces; do not replace internal services with mocks to prove routing.

| Consumer check | Mistake it must catch |
| --- | --- |
| Search → describe → invoke an OpenAPI/API-key tool, an MCP tool and a Google OAuth fixture tool from workspace exec; assert distinct provider outputs | Setup succeeds but discovery/actual tool dispatch remains local, or one plugin family is omitted |
| Invoke discovered paths through the extension SDK; check success and connection-required results | Only the sandbox invoker was changed, or background work opens chat UI |
| Run local file read plus remote call in one exec; repeat the local call during a control-plane outage | Moving whole exec remotely or making local calls depend on remote availability |
| Fail remote search; check explicit partial-source metadata and remote-only error; register a tool after startup | Reporting a misleading empty catalog or using a frozen startup catalog |
| Describe nested schemas with shared definitions and invoke a saved remote path after runtime restart | Dropping schema definitions or requiring a transient address cache |
| Use distinct users and two workspaces for one user | Sending caller-chosen identity, leaking another user's tools, or scoping connections to a VM |
| Resolve a tool with rejected credentials; assert exactly one connection card in the first exec result even when the script handles the failure | Depending on a second model call or relying on the script's return value to surface setup |
| Reauthorize the same connection, observe readiness, then invoke its original address explicitly; put an observable local write before the original failed call | Rejecting reconnection as a duplicate, silently creating a different connection, or replaying an earlier script side effect |
| Return explicit block/approval-required and observe failed activity without a grant UI; preserve existing local approval test | Applying automatic approval in the workspace or bypassing a stricter native policy |
| Cancel an in-flight remote call and simulate a lost response after a provider write; inspect provider count and outcome | Retrying a possibly completed write or claiming cancellation undoes external effects |

For Google, fixture-driven OAuth plus a real routed tool call proves the implementation path, not production consent configuration. Report live-provider, PostgreSQL and desktop checks separately. Run `pnpm run check-affected`, relevant canonical test files, and the actual agent connection-card flow with the existing app tooling; inspect screenshots of any affected card states. No production writes or deployment are part of this phase.

The former Phase 6 (Pi codemode migration) is removed by product decision. Keep Executor's workspace JavaScript runner; moving integrations does not require replacing the sandbox. No Pi dependency upgrade is included.

### ✅ Phase 7: Finish UI handling and remove the old backend

**Today**

After Phase 5, remote calls and automatic connection cards use the control plane, but legacy workspace integration initialization, credential storage and OAuth paths still exist alongside local tool approvals.

**Proposed**

Remove workspace integration initialization, credential access and OAuth handling after consumers use the new path. Preserve Phase 5's automatic connection cards, remote restriction errors and the existing local-tool approval behavior. Leave old user data intact. This phase does not reimplement the card wiring already delivered in Phase 5.

```callstack
 Preserve exec result projection and connection cards delivered in Phase 5
-Initialize the workspace Executor integration backend
+Start workspace Executor with local tools and local approval policies only
+├── route integration calls through the authenticated control-plane client
+├── start and poll remote connection setup through ConnectionService
+│   ├── open setup in a browser tab or Electron's external browser
+│   └── notify the agent when ready without replaying its script
+└── retain local database and historical files without reading old credentials
-Run workspace OAuth callback routes and Electron loopback listeners
+Complete OAuth through the control-plane browser session [[phase7-contract:new:197-204]]
```

Removed workspace credential vaults, Google/OpenAPI integration initialization, OAuth routes, Electron loopback listeners and obsolete configuration. `ConnectionRequest` now describes only control-plane setup; workspace protocol is 25 and control-plane protocol is 4. Ship compatible clients and servers together. Existing local tools, approvals and Executor QuickJS are retained. Background extensions do not open connection cards. Browser launch is tested at the UI transport boundary; canonical server tests cover setup state and provider execution.

### ✅ Phase 8: Verify the complete path and prepare rollout

**Today**

The deployed application uses workspace-local integrations; the new architecture is not live.

**Proposed**

Verify the complete development flow and production database compatibility before requesting rollout. Document reconnection and key recovery. Provision secrets, apply shared schema changes and deploy only with explicit authorization.

Verify two workspaces sharing one user's connection, another user's isolation, refresh and restart recovery, offline local tools, non-blocking approvals and lost-response handling without replaying writes. Run affected checks and relevant package E2Es; do not substitute direct service tests for the consumer flow.

## Delivery state

Phases 1–5 and 7 are implemented. Phase 6 is removed; keep the current runner. Embedded Phase 1–5 patches are historical review checkpoints (including fences named `current-*`); the PR diff is authoritative for the combined implementation. No production deployment, secret provisioning or shared-database migration is part of this delivery. Existing connection data and local approvals remain intact.

**Phase 5 verification:** control-plane full Vitest **36 passed, 4 skipped**, including a real WorkspaceServer agent executing search/describe/invoke over RPC against MCP, OpenAPI and Google OAuth fixtures. The same path verifies invalid-key connection requests, replacement without replay and explicit retry through the original address. It also verifies that abandoned expired reauthorization does not block a new attempt. `pnpm --filter @get-halo/workspace-server exec vitest run test/workspace.test.ts test/oauth.test.ts --maxWorkers=1` finished with **120 passed**. The final targeted routing/cancellation test also passes, including an actual extension process, unavailable remote discovery, local offline calls, persisted remote addresses and missing-connection deduplication. Final `pnpm run check-affected`: **53 successful tasks**. `git diff --check` passes.

The actual compiled browser app, served by the canonical fixture, verified API-key and no-auth MCP completion, Google authorization redirect with a fake client (not live Google success), OAuth-decline callback, pending/cancelled/failed/expired states, password input type in the DOM, and a 390px layout. Inspected screenshots are `.amp/in/artifacts/connection-setup-*.png`. The actual chat card was also rendered in an isolated component fixture: generic MCP branding and the failed-state Connect menu were inspected. The Electron development app could not expose its app-control endpoint, so the desktop browser-launch path was typechecked but not driven live. No live Google account, MCP DCR success, or PostgreSQL execution of this revision was verified.

For Phase 5, `pnpm halo-dev app snapshot` again failed because no Electron app-control endpoint was available. The agent result/card payload is verified through the actual server consumer surface, but the new automatic-card path was not driven in the desktop UI. Earlier screenshots above are Phase 4 evidence, not new Phase 5 captures. No live Google consent, MCP OAuth/DCR, or PostgreSQL multi-replica reconnect test was run.

**Phase 8 final checks:** `pnpm run check-affected` passed all 53 tasks. The full control-plane suite passed 36 tests (4 skipped); canonical workspace/connection suites passed 120 tests after review fixes. Integration calls now follow caller cancellation rather than a global 30-second deadline; a real 31-second call verifies this. Cancellation rereads remote setup status so completed connections remain connected. Electron packaging passed. Three packaged UI tests passed: connection and local approval cards coexist, local approval rejection works, and remote setup opens in another tab while retaining the session. The browser setup test controls the transport response; it does not claim live OAuth. Frozen-lockfile installation and source diff whitespace checks passed; embedded patches retain context-line spaces.

**PR review state:** PR #393 is open but conflicts with newer main changes. Automated review also flagged claimed-setup failure cleanup and missing response-size limits in remote fetch; these require investigation before merge. No integrated-main validation or production-readiness claim is made.

**Phase 8 PostgreSQL verification:** disposable PostgreSQL 15 passed the integration persistence/reopen test, owner isolation and two-replica concurrent same-setup reconnect (one successful completion, same connection address). Four credential tests passed against PostgreSQL: encrypted persistence/reopen, owner separation, wrong-key/tamper rejection and invalid-key rejection. Production-mode integration execution correctly rejects the HTTP fixture before sending a provider request; successful provider execution is covered by SQLite development fixtures, not claimed as a live PostgreSQL provider test.

**Rollout prerequisites:** provision `halo-control-plane-integration-credential-key` in GCP project `halo-relay` and grant only the control-plane identity access. Back up the encryption key with database backups; losing it makes stored credentials unreadable, and replacing it is not key rotation. Restore the matching key to recover encrypted data. Configure the Google OAuth client and control-plane callback URI before live consent testing. Users reconnect existing integrations; there is no credential migration. Live Google consent, MCP OAuth/DCR, disconnect and registration UI remain follow-up work. No live provider writes were used for verification.

### Phase 5 host capability patch

```source-diff:phase5-tools:packages/workspace-server/src/agent/runtime/ToolRuntime.ts
diff --git a/packages/workspace-server/src/agent/runtime/ToolRuntime.ts b/packages/workspace-server/src/agent/runtime/ToolRuntime.ts
index efb913a..a8bd93f 100644
--- a/packages/workspace-server/src/agent/runtime/ToolRuntime.ts
+++ b/packages/workspace-server/src/agent/runtime/ToolRuntime.ts
@@ -1,0 +2,22 @@ import { AsyncLocalStorage } from "node:async_hooks";
+import type { RemoteConnectionBackend } from "./ConnectionService.js";
+import type {
+  IntegrationJson,
+  IntegrationTool,
+  IntegrationToolSchema,
+  IntegrationInvocation,
+} from "@get-halo/shared/controlPlaneContract";
+
+export interface RemoteIntegrationTools {
+  search(
+    input: { query: string; integration?: string; limit?: number },
+    signal?: AbortSignal,
+  ): Promise<{ tools: IntegrationTool[]; truncated: boolean } | Error>;
+  describe(
+    input: { address: string },
+    signal?: AbortSignal,
+  ): Promise<IntegrationToolSchema | Error>;
+  invoke(
+    input: { address: string; arguments: Record<string, IntegrationJson> },
+    signal?: AbortSignal,
+  ): Promise<IntegrationInvocation | Error>;
+}
```

## References

- [[packages/workspace-server/src/agent/runtime/ToolRuntime.ts]] — current combined owner.
- [[packages/workspace-server/src/agent/runtime/createExecutorDatabase.ts]] — existing workspace adapter, not the proposed control-plane adapter.
- [[apps/control-plane/src/credentials/CredentialService.ts]] — central encrypted credential storage; the workspace credential provider was removed.
- [[apps/control-plane/src/server/ControlPlane.ts]] and [[apps/control-plane/src/DatabaseService.ts]] — host composition and database lifetime.
- [[packages/config/src/controlPlane.ts]] — existing configuration and secret loading.
- [[packages/workspace-server/src/agent/runtime/ConnectionService.ts]] and [[packages/workspace-server/src/agent/ToolApprovalService.ts]] — current connection and approval coordination.
- [[packages/web/src/main/agent/sessionView.ts]] and [[packages/web/src/main/agent/AgentPane.tsx]] — structured result projection and cards.
- [Executor database contract](https://github.com/UsefulSoftwareCo/executor/blob/v1.6.0/packages/core/sdk/src/promise-executor.ts), [FumaDB adapter](https://github.com/UsefulSoftwareCo/executor/blob/v1.6.0/packages/core/sdk/src/executor-fuma-db.ts), [schema initialization](https://github.com/UsefulSoftwareCo/executor/blob/v1.6.0/packages/core/fumadb/src/adapters/drizzle/runtime.ts).
- [Executor policies](https://github.com/UsefulSoftwareCo/executor/blob/v1.6.0/packages/core/sdk/src/policies.ts) and [OAuth storage](https://github.com/UsefulSoftwareCo/executor/blob/v1.6.0/packages/core/sdk/src/oauth-service.ts).
- [Pi 1.0 codemode](https://github.com/earendil-works/pi/blob/v1.0.0/packages/codemode/README.md).


## Historical Phase 1 implementation checkpoint


```source-diff:phase1-host:apps/control-plane/src/server/ControlPlane.ts
diff --git a/apps/control-plane/src/server/ControlPlane.ts b/apps/control-plane/src/server/ControlPlane.ts
index 099a660..47168d2 100644
--- a/apps/control-plane/src/server/ControlPlane.ts
+++ b/apps/control-plane/src/server/ControlPlane.ts
@@ -15,6 +15,8 @@ import type { WorkspaceProviderApi } from "../workspace/provider/WorkspaceProvid
 
 import { TraceIngestion } from "../traces/TraceIngestion.js";
 import type { TraceCloud } from "../traces/TraceCloud.js";
+import { CredentialService } from "../credentials/CredentialService.js";
+import { IntegrationService } from "../integrations/IntegrationService.js";
 
 const loopbackHost = "127.0.0.1";
 const cloudRunHost = "0.0.0.0";
@@ -25,17 +27,20 @@ export class ControlPlane {
   private readonly publicOrigin: string;
   // Owns active requests that upgraded beyond the HTTP server lifecycle.
   private readonly requests: ServingControlPlaneHttp;
+  readonly integrations: IntegrationService | undefined;
 
   private constructor(ctx: {
     db: DatabaseService;
     http: ListeningControlPlaneHttp;
     publicOrigin: string;
     requests: ServingControlPlaneHttp;
+    integrations: IntegrationService | undefined;
   }) {
     this.db = ctx.db;
     this.http = ctx.http;
     this.publicOrigin = ctx.publicOrigin;
     this.requests = ctx.requests;
+    this.integrations = ctx.integrations;
   }
 
   get origin() {
@@ -50,6 +55,8 @@ export class ControlPlane {
     traceCloud?: TraceCloud;
     inferenceApiKey?: string;
     workspaceIdleTimeoutMs?: number;
+    integrationEncryptionKey?: Buffer;
+    getOpenAPISpec?: (url: string) => Promise<string | Error>;
   }) {
     const { config, webRoot } = ctx;
     await using cleanup = new errore.AsyncDisposableStack();
@@ -94,6 +101,28 @@ export class ControlPlane {
     });
     if (workspace instanceof Error) return workspace;
 
+    const credentials =
+      ctx.integrationEncryptionKey === undefined
+        ? undefined
+        : await CredentialService.start({
+            db,
+            encryptionKey: ctx.integrationEncryptionKey,
+          });
+    if (credentials instanceof Error) return credentials;
+    const integrations =
+      credentials === undefined
+        ? undefined
+        : await IntegrationService.start({
+            db,
+            credentials,
+            getOpenAPISpec: ctx.getOpenAPISpec,
+          });
+    if (integrations instanceof Error) return integrations;
+    cleanup.defer(async () => {
+      const closed = await integrations?.close();
+      if (closed instanceof Error) console.error(closed);
+    });
+
     const requests = serveControlPlaneHttp({
       server: http.server,
       auth,
@@ -117,15 +146,18 @@ export class ControlPlane {
       http,
       publicOrigin,
       requests,
+      integrations,
     });
   }
 
   async close() {
     this.requests.close();
     const httpClosed = await closeControlPlaneHttp(this.http.server);
+    const integrationsClosed = await this.integrations?.close();
     const databaseClosed = await this.db.close();
 
     if (httpClosed instanceof Error) return httpClosed;
+    if (integrationsClosed instanceof Error) return integrationsClosed;
     if (databaseClosed instanceof Error) return databaseClosed;
   }
 }
```

```source-diff:phase1-database:apps/control-plane/src/DatabaseService.ts
diff --git a/apps/control-plane/src/DatabaseService.ts b/apps/control-plane/src/DatabaseService.ts
index 429c6f2..4a548d8 100644
--- a/apps/control-plane/src/DatabaseService.ts
+++ b/apps/control-plane/src/DatabaseService.ts
@@ -17,9 +17,14 @@ export type DatabaseClient = DatabaseSync | Pool;
 
 export class DatabaseService {
   private readonly database: DatabaseClient;
+  private readonly integrations: DatabaseClient;
 
-  private constructor(ctx: { client: DatabaseClient }) {
+  private constructor(ctx: {
+    client: DatabaseClient;
+    integrations: DatabaseClient;
+  }) {
     this.database = ctx.client;
+    this.integrations = ctx.integrations;
   }
 
   static async start(config: DatabaseConfig) {
@@ -32,7 +37,7 @@ export class DatabaseService {
       });
       if (client instanceof Error) return client;
 
-      return new DatabaseService({ client });
+      return new DatabaseService({ client, integrations: client });
     }
 
     const created = await fs
@@ -53,19 +58,41 @@ export class DatabaseService {
     });
     if (client instanceof Error) return client;
 
-    return new DatabaseService({ client });
+    // SQLite has one writer. Keep asynchronous Executor transactions off the
+    // synchronous auth connection (and its file), while owning both lifetimes.
+    const integrations = errore.try({
+      try: () => new DatabaseSync(`${config.path}.integrations`),
+      catch: (cause) =>
+        new DatabaseServiceError({
+          detail: "open integration database",
+          cause,
+        }),
+    });
+    if (integrations instanceof Error) {
+      client.close();
+      return integrations;
+    }
+    return new DatabaseService({ client, integrations });
   }
 
   get client() {
     return this.database;
   }
 
+  get integrationClient() {
+    return this.integrations;
+  }
+
   async close() {
     const client = this.database;
 
     if (client instanceof DatabaseSync) {
       return errore.try({
-        try: () => client.close(),
+        try: () => {
+          if (this.integrations instanceof DatabaseSync)
+            this.integrations.close();
+          client.close();
+        },
         catch: (cause) =>
           new DatabaseServiceError({
             detail: "close SQLite database",
```

```source-diff:phase1-credentials:apps/control-plane/src/credentials/CredentialService.ts
diff --git a/apps/control-plane/src/credentials/CredentialService.ts b/apps/control-plane/src/credentials/CredentialService.ts
new file mode 100644
index 0000000..d2c4033
--- /dev/null
+++ b/apps/control-plane/src/credentials/CredentialService.ts
@@ -0,0 +1,305 @@
+import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
+import { DatabaseSync } from "node:sqlite";
+import { Type } from "@sinclair/typebox";
+import { Value } from "@sinclair/typebox/value";
+import * as errore from "errore";
+import type { DatabaseService } from "../DatabaseService.js";
+
+const keyLength = 32;
+const nonceLength = 12;
+const authTagLength = 16;
+
+const credentialRowSchema = Type.Object({
+  nonce: Type.String(),
+  ciphertext: Type.String(),
+  auth_tag: Type.String(),
+});
+const credentialIdRowSchema = Type.Object({ credential_id: Type.String() });
+
+class CredentialServiceError extends errore.createTaggedError({
+  name: "CredentialServiceError",
+  message: "Credential service failed: $detail",
+}) {}
+
+export class InvalidCredentialKeyError extends errore.createTaggedError({
+  name: "InvalidCredentialKeyError",
+  message: "Credential encryption key must be $expected bytes",
+}) {}
+
+export class CredentialDecryptionError extends errore.createTaggedError({
+  name: "CredentialDecryptionError",
+  message: "Credential $credentialId could not be decrypted",
+}) {}
+
+type CredentialServiceOptions = {
+  db: DatabaseService;
+  encryptionKey: Buffer;
+};
+
+type EncryptedCredential = {
+  nonce: string;
+  ciphertext: string;
+  authTag: string;
+};
+
+/**
+ * Stores user credentials encrypted with AES-256-GCM in the borrowed database.
+ * The additional authenticated data binds each value to its user and credential
+ * identifiers, so a row copied to another owner or identifier fails to decrypt.
+ */
+export class CredentialService {
+  private readonly db: DatabaseService;
+  private readonly encryptionKey: Buffer;
+
+  private constructor(ctx: CredentialServiceOptions) {
+    const { db, encryptionKey } = ctx;
+    this.db = db;
+    this.encryptionKey = encryptionKey;
+  }
+
+  static async start(options: CredentialServiceOptions) {
+    if (options.encryptionKey.length !== keyLength)
+      return new InvalidCredentialKeyError({ expected: String(keyLength) });
+
+    const service = new CredentialService({
+      db: options.db,
+      // Copy so later caller mutation cannot change the active key.
+      encryptionKey: Buffer.from(options.encryptionKey),
+    });
+    const migrated = await service.migrate();
+    if (migrated instanceof Error) return migrated;
+    return service;
+  }
+
+  async get(userId: string, credentialId: string) {
+    const row = await this.selectRow(userId, credentialId);
+    if (row instanceof Error) return row;
+    if (row === undefined) return undefined;
+    return this.decrypt({ userId, credentialId, row });
+  }
+
+  async set(userId: string, credentialId: string, value: string) {
+    const row = this.encrypt({ userId, credentialId, value });
+    const updatedAt = new Date().toISOString();
+    const sql = `INSERT INTO credential (user_id, credential_id, nonce, ciphertext, auth_tag, updated_at)
+      VALUES ($1, $2, $3, $4, $5, $6)
+      ON CONFLICT (user_id, credential_id) DO UPDATE SET
+        nonce = excluded.nonce,
+        ciphertext = excluded.ciphertext,
+        auth_tag = excluded.auth_tag,
+        updated_at = excluded.updated_at`;
+    const params = [
+      userId,
+      credentialId,
+      row.nonce,
+      row.ciphertext,
+      row.authTag,
+      updatedAt,
+    ];
+    const client = this.db.client;
+
+    if (client instanceof DatabaseSync) {
+      return errore.try({
+        try: () => {
+          client.prepare(sql.replace(/\$\d+/gu, "?")).run(...params);
+        },
+        catch: (cause) =>
+          new CredentialServiceError({ detail: "write SQLite row", cause }),
+      });
+    }
+
+    return await client
+      .query(sql, params)
+      .then(() => undefined)
+      .catch(
+        (cause) =>
+          new CredentialServiceError({ detail: "write PostgreSQL row", cause }),
+      );
+  }
+
+  async delete(userId: string, credentialId: string) {
+    const sql =
+      "DELETE FROM credential WHERE user_id = $1 AND credential_id = $2";
+    const client = this.db.client;
+
+    if (client instanceof DatabaseSync) {
+      return errore.try({
+        try: () => {
+          client.prepare(sql.replace(/\$\d+/gu, "?")).run(userId, credentialId);
+        },
+        catch: (cause) =>
+          new CredentialServiceError({ detail: "delete SQLite row", cause }),
+      });
+    }
+
+    return await client
+      .query(sql, [userId, credentialId])
+      .then(() => undefined)
+      .catch(
+        (cause) =>
+          new CredentialServiceError({
+            detail: "delete PostgreSQL row",
+            cause,
+          }),
+      );
+  }
+
+  async list(userId: string) {
+    const sql =
+      "SELECT credential_id FROM credential WHERE user_id = $1 ORDER BY credential_id";
+    const client = this.db.client;
+
+    const rows: unknown[] | CredentialServiceError =
+      client instanceof DatabaseSync
+        ? errore.try({
+            try: () => client.prepare(sql.replace(/\$\d+/gu, "?")).all(userId),
+            catch: (cause) =>
+              new CredentialServiceError({ detail: "list SQLite rows", cause }),
+          })
+        : await client
+            .query(sql, [userId])
+            .then((result) => result.rows)
+            .catch(
+              (cause) =>
+                new CredentialServiceError({
+                  detail: "list PostgreSQL rows",
+                  cause,
+                }),
+            );
+    if (rows instanceof Error) return rows;
+
+    const credentialIds: string[] = [];
+    for (const row of rows) {
+      if (!Value.Check(credentialIdRowSchema, row))
+        return new CredentialServiceError({ detail: "read malformed row" });
+      credentialIds.push(row.credential_id);
+    }
+    return credentialIds;
+  }
+
+  private async selectRow(userId: string, credentialId: string) {
+    const sql = `SELECT nonce, ciphertext, auth_tag FROM credential
+      WHERE user_id = $1 AND credential_id = $2`;
+    const client = this.db.client;
+
+    const row: unknown =
+      client instanceof DatabaseSync
+        ? errore.try({
+            try: () =>
+              client
+                .prepare(sql.replace(/\$\d+/gu, "?"))
+                .get(userId, credentialId),
+            catch: (cause) =>
+              new CredentialServiceError({ detail: "read SQLite row", cause }),
+          })
+        : await client
+            .query(sql, [userId, credentialId])
+            .then((result) => result.rows[0])
+            .catch(
+              (cause) =>
+                new CredentialServiceError({
+                  detail: "read PostgreSQL row",
+                  cause,
+                }),
+            );
+    if (row instanceof Error) return row;
+    if (row === undefined) return undefined;
+
+    if (!Value.Check(credentialRowSchema, row))
+      return new CredentialServiceError({ detail: "read malformed row" });
+    return {
+      nonce: row.nonce,
+      ciphertext: row.ciphertext,
+      authTag: row.auth_tag,
+    };
+  }
+
+  private encrypt(ctx: {
+    userId: string;
+    credentialId: string;
+    value: string;
+  }): EncryptedCredential {
+    const nonce = randomBytes(nonceLength);
+    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce, {
+      authTagLength,
+    });
+    cipher.setAAD(additionalData(ctx.userId, ctx.credentialId));
+    const ciphertext = Buffer.concat([
+      cipher.update(ctx.value, "utf8"),
+      cipher.final(),
+    ]);
+    return {
+      nonce: nonce.toString("base64"),
+      ciphertext: ciphertext.toString("base64"),
+      authTag: cipher.getAuthTag().toString("base64"),
+    };
+  }
+
+  private decrypt(ctx: {
+    userId: string;
+    credentialId: string;
+    row: EncryptedCredential;
+  }) {
+    const { userId, credentialId, row } = ctx;
+    return errore.try({
+      try: () => {
+        const decipher = createDecipheriv(
+          "aes-256-gcm",
+          this.encryptionKey,
+          Buffer.from(row.nonce, "base64"),
+          { authTagLength },
+        );
+        decipher.setAAD(additionalData(userId, credentialId));
+        decipher.setAuthTag(Buffer.from(row.authTag, "base64"));
+        return Buffer.concat([
+          decipher.update(Buffer.from(row.ciphertext, "base64")),
+          decipher.final(),
+        ]).toString("utf8");
+      },
+      catch: (cause) => new CredentialDecryptionError({ credentialId, cause }),
+    });
+  }
+
+  private async migrate() {
+    const client = this.db.client;
+
+    if (client instanceof DatabaseSync) {
+      return errore.try({
+        try: () => client.exec(credentialTableSql("TEXT")),
+        catch: (cause) =>
+          new CredentialServiceError({
+            detail: "migrate SQLite schema",
+            cause,
+          }),
+      });
+    }
+
+    return await client
+      .query(credentialTableSql("TIMESTAMPTZ"))
+      .then(() => undefined)
+      .catch(
+        (cause) =>
+          new CredentialServiceError({
+            detail: "migrate PostgreSQL schema",
+            cause,
+          }),
+      );
+  }
+}
+
+function credentialTableSql(timestamp: "TEXT" | "TIMESTAMPTZ") {
+  return `CREATE TABLE IF NOT EXISTS credential (
+    user_id TEXT NOT NULL,
+    credential_id TEXT NOT NULL,
+    nonce TEXT NOT NULL,
+    ciphertext TEXT NOT NULL,
+    auth_tag TEXT NOT NULL,
+    updated_at ${timestamp} NOT NULL,
+    PRIMARY KEY (user_id, credential_id)
+  )`;
+}
+
+// JSON encoding keeps the identifier boundary unambiguous.
+function additionalData(userId: string, credentialId: string) {
+  return Buffer.from(JSON.stringify([userId, credentialId]), "utf8");
+}
```

```source-diff:phase1-adapter:apps/control-plane/src/integrations/createExecutorDatabase.ts
diff --git a/apps/control-plane/src/integrations/createExecutorDatabase.ts b/apps/control-plane/src/integrations/createExecutorDatabase.ts
new file mode 100644
index 0000000..3fe7e87
--- /dev/null
+++ b/apps/control-plane/src/integrations/createExecutorDatabase.ts
@@ -0,0 +1,99 @@
+import { DatabaseSync, type SQLInputValue } from "node:sqlite";
+import {
+  createDrizzleRuntimeSchemaFromTables,
+  ensureDrizzleRuntimeSchemaFromTables,
+} from "@executor-js/fumadb/adapters/drizzle";
+import type { AbstractQuery } from "@executor-js/fumadb/query";
+import type { AnySchema } from "@executor-js/fumadb/schema";
+import { collectTables } from "@executor-js/sdk/core";
+import { createExecutorFumaDb } from "@executor-js/sdk/host-internal";
+import { SerialQueue } from "@get-halo/shared/SerialQueue";
+import { drizzle as postgres } from "drizzle-orm/node-postgres";
+import { drizzle as sqlite } from "drizzle-orm/sqlite-proxy";
+import * as errore from "errore";
+import type { DatabaseService } from "../DatabaseService.js";
+
+class ExecutorDatabaseError extends errore.createTaggedError({
+  name: "ExecutorDatabaseError",
+  message: "Initialize Executor database",
+}) {}
+
+export async function createExecutorDatabase(db: DatabaseService) {
+  const client = db.integrationClient;
+  const options = {
+    tables: collectTables(),
+    namespace: "halo_executor",
+    version: "1.0.0",
+    provider:
+      client instanceof DatabaseSync
+        ? ("sqlite" as const)
+        : ("postgresql" as const),
+  };
+  const schema = createDrizzleRuntimeSchemaFromTables(options);
+  const database =
+    client instanceof DatabaseSync
+      ? sqlite(
+          async (sql, params: SQLInputValue[], method) => {
+            const statement = client.prepare(sql);
+            statement.setReturnArrays(true);
+            if (method === "run") {
+              statement.run(...params);
+              return { rows: [] };
+            }
+            // node:sqlite's typings still describe objects with setReturnArrays(true).
+            const rows =
+              method === "get"
+                ? statement.get(...params)
+                : statement.all(...params);
+            return {
+              rows:
+                rows === undefined
+                  ? []
+                  : method === "get"
+                    ? Object.values(rows)
+                    : Object.values(rows).map(Object.values),
+            };
+          },
+          { schema },
+        )
+      : postgres(client, { schema });
+  const initialized = await ensureDrizzleRuntimeSchemaFromTables(
+    database,
+    options,
+  ).catch((cause) => new ExecutorDatabaseError({ cause }));
+  if (initialized instanceof Error) return initialized;
+  const query = createExecutorFumaDb(database, options).db;
+  return client instanceof DatabaseSync
+    ? serialize(query, new SerialQueue())
+    : query;
+}
+
+// Serialize whole transactions, not their individual statements. Preserve
+// Fuma's non-enumerable policy context; transaction callbacks use the raw query.
+function serialize<S extends AnySchema>(
+  db: AbstractQuery<S>,
+  queue: SerialQueue,
+): AbstractQuery<S> {
+  return {
+    internal: db.internal,
+    withContext: (context) => serialize(db.withContext!(context), queue),
+    count: async (table, options) =>
+      await queue.run(async () => await db.count(table, options)),
+    findFirst: async (table, options) =>
+      await queue.run(async () => await db.findFirst(table, options)),
+    findMany: async (table, options) =>
+      await queue.run(async () => await db.findMany(table, options)),
+    create: async (table, values) =>
+      await queue.run(async () => await db.create(table, values)),
+    createMany: async (table, values) =>
+      await queue.run(async () => await db.createMany(table, values)),
+    updateMany: async (table, options) =>
+      await queue.run(async () => await db.updateMany(table, options)),
+    deleteMany: async (table, options) =>
+      await queue.run(async () => await db.deleteMany(table, options)),
+    upsert: async (table, options) =>
+      await queue.run(async () => await db.upsert(table, options)),
+    transaction: async (run) =>
+      await queue.run(async () => await db.transaction(run)),
+  };
+}
```

```source-diff:phase1-integrations:apps/control-plane/src/integrations/IntegrationService.ts
diff --git a/apps/control-plane/src/integrations/IntegrationService.ts b/apps/control-plane/src/integrations/IntegrationService.ts
new file mode 100644
index 0000000..874b78d
--- /dev/null
+++ b/apps/control-plane/src/integrations/IntegrationService.ts
@@ -0,0 +1,279 @@
+import { openApiPlugin } from "@executor-js/plugin-openapi/core";
+import {
+  googleCatalog,
+  googleDiscoveryAdapter,
+} from "@executor-js/plugin-openapi/providers/google";
+import {
+  createExecutor,
+  Effect,
+  IntegrationSlug,
+  ProviderItemId,
+  ProviderKey,
+  StorageError,
+  Subject,
+  Tenant,
+  type CredentialProvider,
+  type Executor,
+  type ProviderEntry,
+} from "@executor-js/sdk/core";
+import { Layer } from "effect";
+import { FetchHttpClient } from "effect/unstable/http";
+import * as errore from "errore";
+import type { CredentialService } from "../credentials/CredentialService.js";
+import type { DatabaseService } from "../DatabaseService.js";
+import { createExecutorDatabase } from "./createExecutorDatabase.js";
+
+// Executor 1.6 rewrites Meet's Discovery URL to a legacy endpoint returning 404.
+const presets = googleCatalog.filter((preset) => preset.id !== "google-meet");
+type IntegrationPlugins = readonly [ReturnType<typeof openApiPlugin>];
+type IntegrationExecutor = Executor<IntegrationPlugins>;
+
+class IntegrationServiceError extends errore.createTaggedError({
+  name: "IntegrationServiceError",
+  message: "Integration service failed: $detail",
+}) {}
+
+export class IntegrationService {
+  // Coalesce first-use initialization per user and drain all work before shutdown.
+  private readonly executors = new Map<
+    string,
+    Promise<IntegrationExecutor | IntegrationServiceError>
+  >();
+  private readonly active = new Set<Promise<unknown>>();
+  private closed = false;
+  private readonly database: Exclude<
+    Awaited<ReturnType<typeof createExecutorDatabase>>,
+    Error
+  >;
+  private readonly credentials: CredentialService;
+  private readonly plugins: IntegrationPlugins;
+
+  private constructor(ctx: {
+    database: Exclude<
+      Awaited<ReturnType<typeof createExecutorDatabase>>,
+      Error
+    >;
+    credentials: CredentialService;
+    getOpenAPISpec?: (url: string) => Promise<string | Error>;
+  }) {
+    this.database = ctx.database;
+    this.credentials = ctx.credentials;
+    const getOpenAPISpec = ctx.getOpenAPISpec;
+    // Only spec loading is overridden. Tool invocations keep Executor's normal HTTP client.
+    const httpClientLayer =
+      getOpenAPISpec === undefined
+        ? undefined
+        : FetchHttpClient.layer.pipe(
+            Layer.provide(
+              Layer.succeed(FetchHttpClient.Fetch, async (input) => {
+                const spec = await getOpenAPISpec(
+                  input instanceof Request ? input.url : String(input),
+                );
+                // Fetch reports failure by rejecting; adapt Halo's error value at this SDK boundary.
+                if (spec instanceof Error) throw spec;
+                return new Response(spec, {
+                  headers: { "content-type": "application/json" },
+                });
+              }),
+            ),
+          );
+    this.plugins = [
+      openApiPlugin({
+        presets,
+        specFormats: [
+          httpClientLayer === undefined
+            ? googleDiscoveryAdapter
+            : {
+                ...googleDiscoveryAdapter,
+                fetch: (input) =>
+                  googleDiscoveryAdapter.fetch({ ...input, httpClientLayer }),
+              },
+        ],
+      }),
+    ];
+  }
+
+  static async start(ctx: {
+    db: DatabaseService;
+    credentials: CredentialService;
+    getOpenAPISpec?: (url: string) => Promise<string | Error>;
+  }) {
+    const database = await createExecutorDatabase(ctx.db);
+    if (database instanceof Error) return database;
+    return new IntegrationService({
+      database,
+      credentials: ctx.credentials,
+      getOpenAPISpec: ctx.getOpenAPISpec,
+    });
+  }
+
+  // Internal boundary only. Phase 2 derives userId from authenticated runtime
+  // state and exposes narrow operations; callers must not retain the executor.
+  async withUser<A, E>(
+    userId: string,
+    run: (executor: IntegrationExecutor) => Effect.Effect<A, E>,
+  ) {
+    if (this.closed)
+      return new IntegrationServiceError({ detail: "service is closed" });
+    const work = this.run(userId, run);
+    this.active.add(work);
+    await using cleanup = new errore.AsyncDisposableStack();
+    cleanup.defer(() => {
+      this.active.delete(work);
+    });
+    return await work;
+  }
+
+  private async run<A, E>(
+    userId: string,
+    run: (executor: IntegrationExecutor) => Effect.Effect<A, E>,
+  ) {
+    let pending = this.executors.get(userId);
+    if (pending === undefined) {
+      pending = this.create(userId);
+      this.executors.set(userId, pending);
+    }
+    const executor = await pending;
+    if (executor instanceof Error) {
+      this.executors.delete(userId);
+      return executor;
+    }
+    return await Effect.runPromise(run(executor)).catch(
+      (cause) =>
+        new IntegrationServiceError({ detail: "execute operation", cause }),
+    );
+  }
+
+  private async create(userId: string) {
+    const executor = await Effect.runPromise(
+      createExecutor({
+        tenant: Tenant.make(userId),
+        subject: Subject.make(userId),
+        db: this.database,
+        providers: [this.credentialProvider(userId)],
+        plugins: this.plugins,
+        onElicitation: () => Effect.succeed({ action: "decline" as const }),
+      }),
+    ).catch(
+      (cause) =>
+        new IntegrationServiceError({ detail: "create Executor", cause }),
+    );
+    if (executor instanceof Error) return executor;
+    await using cleanup = new errore.AsyncDisposableStack();
+    cleanup.defer(async () => {
+      const result = await Effect.runPromise(executor.close()).catch(
+        (cause) =>
+          new IntegrationServiceError({ detail: "close Executor", cause }),
+      );
+      if (result instanceof Error) console.error(result);
+    });
+    for (const preset of presets) {
+      const { defaultSlug, url, specFormat } = preset;
+      if (
+        defaultSlug === undefined ||
+        url === undefined ||
+        specFormat === undefined
+      )
+        return new IntegrationServiceError({
+          detail: `preset ${preset.id} cannot be installed`,
+        });
+      const installed = await Effect.runPromise(
+        Effect.gen(function* () {
+          const existing = yield* executor.integrations.get(
+            IntegrationSlug.make(defaultSlug),
+          );
+          if (existing !== null) return;
+          yield* executor.openapi.addSpec({
+            spec: { kind: "url", url },
+            slug: defaultSlug,
+            name: preset.name,
+            description: preset.summary,
+            specFormat,
+            family: preset.family,
+            authenticationTemplate: preset.authTemplate?.flatMap((method) =>
+              method.kind === "oauth2" ? [method] : [],
+            ),
+            healthCheck: preset.healthCheck,
+          });
+        }),
+      ).catch(
+        (cause) =>
+          new IntegrationServiceError({
+            detail: `install ${preset.id}`,
+            cause,
+          }),
+      );
+      if (installed instanceof Error) return installed;
+    }
+    cleanup.move();
+    return executor;
+  }
+
+  private credentialProvider(userId: string): CredentialProvider {
+    return {
+      key: ProviderKey.make("halo"),
+      writable: true,
+      get: (credentialId: ProviderItemId) =>
+        toEffect("get credential", async () => {
+          const value = await this.credentials.get(userId, credentialId);
+          // oxlint-disable-next-line unicorn/no-null -- Executor's provider contract uses null for absence.
+          return value === undefined ? null : value;
+        }),
+      has: (credentialId: ProviderItemId) =>
+        toEffect("check credential", async () => {
+          const value = await this.credentials.get(userId, credentialId);
+          if (value instanceof Error) return value;
+          return value !== undefined;
+        }),
+      set: (credentialId: ProviderItemId, value: string) =>
+        toEffect(
+          "set credential",
+          async () => await this.credentials.set(userId, credentialId, value),
+        ),
+      delete: (credentialId: ProviderItemId) =>
+        toEffect(
+          "delete credential",
+          async () => await this.credentials.delete(userId, credentialId),
+        ),
+      list: () =>
+        toEffect<ProviderEntry[]>("list credentials", async () => {
+          const ids = await this.credentials.list(userId);
+          if (ids instanceof Error) return ids;
+          return ids.map((id) => ({ id: ProviderItemId.make(id), name: id }));
+        }),
+    };
+  }
+
+  async close() {
+    this.closed = true;
+    await Promise.all(this.active);
+    const executors = await Promise.all(this.executors.values());
+    this.executors.clear();
+    const results = await Promise.all(
+      executors.map(async (executor) => {
+        if (executor instanceof Error) return;
+        return await Effect.runPromise(executor.close()).catch(
+          (cause) =>
+            new IntegrationServiceError({ detail: "close Executor", cause }),
+        );
+      }),
+    );
+    return results.find((result) => result instanceof Error);
+  }
+}
+
+function toEffect<A>(
+  label: string,
+  run: () => Promise<A | Error>,
+): Effect.Effect<A, StorageError> {
+  return Effect.flatMap(Effect.promise(run), (value) =>
+    value instanceof Error
+      ? Effect.fail(
+          new StorageError({
+            message: `${label}: ${value.message}`,
+            cause: value,
+          }),
+        )
+      : Effect.succeed(value),
+  );
+}
```

```source-diff:phase1-config:packages/config/src/controlPlane.ts
diff --git a/packages/config/src/controlPlane.ts b/packages/config/src/controlPlane.ts
index 661743e..cb1da29 100644
--- a/packages/config/src/controlPlane.ts
+++ b/packages/config/src/controlPlane.ts
@@ -65,6 +65,7 @@ export type ControlPlaneApplicationConfig = {
   mode: ApplicationMode;
   server: ControlPlaneConfig;
   inferenceApiKey: string;
+  integrationEncryptionKey: Buffer;
 };
 
 interface AuthSecretIds {
@@ -100,6 +101,9 @@ export async function readControlPlaneConfig(): Promise<
     secretId: "together-ai-api-key",
   });
   if (inferenceApiKey instanceof Error) return inferenceApiKey;
+  const integrationEncryptionKey = await readIntegrationEncryptionKey();
+  if (integrationEncryptionKey instanceof Error)
+    return integrationEncryptionKey;
   return {
     mode:
       configPath === undefined && process.env.K_SERVICE === undefined
@@ -107,9 +111,24 @@ export async function readControlPlaneConfig(): Promise<
         : ApplicationMode.Production,
     server,
     inferenceApiKey,
+    integrationEncryptionKey,
   };
 }
 
+async function readIntegrationEncryptionKey() {
+  const encoded = await readGcpSecret({
+    projectId: secretProjectId,
+    secretId: "halo-control-plane-integration-credential-key",
+  });
+  if (encoded instanceof Error) return encoded;
+  const key = Buffer.from(encoded.trim(), "base64");
+  if (key.length !== 32 || key.toString("base64") !== encoded.trim())
+    return new ControlPlaneConfigError({
+      detail: "integration key must be 32 bytes encoded as base64",
+    });
+  return key;
+}
+
 async function readConfigFile(configPath: string) {
   const raw = await fs.readFile(configPath, "utf8").catch(
     (cause) =>
```

```source-diff:phase1-main:apps/control-plane/src/main.ts
diff --git a/apps/control-plane/src/main.ts b/apps/control-plane/src/main.ts
index a7dcf1f..1b03a0a 100644
--- a/apps/control-plane/src/main.ts
+++ b/apps/control-plane/src/main.ts
@@ -35,6 +35,7 @@ async function run() {
           },
     config: config.server,
     inferenceApiKey: config.inferenceApiKey,
+    integrationEncryptionKey: config.integrationEncryptionKey,
     workspaceProvider,
     traceCloud:
       config.server.deployment === "cloudRun"
```

```source-diff:phase1-tests:apps/control-plane/test/ControlPlane.test.ts
diff --git a/apps/control-plane/test/ControlPlane.test.ts b/apps/control-plane/test/ControlPlane.test.ts
index 05ef42f..2dfafcf 100644
--- a/apps/control-plane/test/ControlPlane.test.ts
+++ b/apps/control-plane/test/ControlPlane.test.ts
@@ -1,4 +1,12 @@
 import { gzipSync } from "node:zlib";
+import {
+  AuthTemplateSlug,
+  ConnectionName,
+  Effect,
+  IntegrationSlug,
+  Owner,
+  ToolAddress,
+} from "@executor-js/sdk/core";
 import { TraceCloudDriver } from "./TraceCloudDriver.js";
 import fs from "node:fs/promises";
 import http from "node:http";
@@ -94,6 +102,32 @@ const testAuth = {
 
 const desktopAuthState = "desktop-auth-state-0123456789abcdef";
 
+const integrationEncryptionKey = Buffer.alloc(32, 17);
+// Only Google's external Discovery HTTP boundary is replaced. Executor parses,
+// installs and persists the document through its real OpenAPI plugin.
+const getOpenAPISpec = async (_url: string) =>
+  JSON.stringify({
+    discoveryVersion: "v1",
+    id: "test:v1",
+    name: "test",
+    version: "v1",
+    title: "Test Google API",
+    rootUrl: "https://example.invalid/",
+    servicePath: "test/v1/",
+    resources: {
+      documents: {
+        methods: {
+          list: {
+            id: "test.documents.list",
+            path: "documents",
+            httpMethod: "GET",
+            response: { type: "object" },
+          },
+        },
+      },
+    },
+  });
+
 const controlPlaneTest = test.extend<{
   traceCloud: TraceCloudDriver;
   inferenceApiKey: string | undefined;
@@ -105,7 +139,45 @@ const controlPlaneTest = test.extend<{
   webRoot: string;
   workspaceProvider: WorkspaceProviderApi;
   workspaceHost: WorkspaceHostDriver;
+  integrationApi: {
+    origin: string;
+    requests: { url: string | undefined; authorization: string | undefined }[];
+  };
 }>({
+  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
+  integrationApi: async ({}, use) => {
+    const requests: {
+      url: string | undefined;
+      authorization: string | undefined;
+    }[] = [];
+    const server = http.createServer((request, response) => {
+      requests.push({
+        url: request.url,
+        authorization: request.headers.authorization,
+      });
+      if (request.url !== "/items") {
+        response.writeHead(404).end();
+        return;
+      }
+      response
+        .writeHead(200, { "content-type": "application/json" })
+        .end(JSON.stringify({ items: ["fixture-item"] }));
+    });
+    server.listen(0, "127.0.0.1");
+    await events.once(server, "listening");
+    await using cleanup = new errore.AsyncDisposableStack();
+    cleanup.defer(async () => {
+      server.closeAllConnections();
+      await new Promise<void>((resolveClose, reject) =>
+        server.close((error) =>
+          error === undefined ? resolveClose() : reject(error),
+        ),
+      );
+    });
+    // SAFETY: A listening TCP server has AddressInfo, not a pipe address.
+    const address = server.address() as AddressInfo;
+    await use({ origin: `http://127.0.0.1:${address.port}`, requests });
+  },
   // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
   inferenceApiKey: async ({}, use) => {
     await use(process.env.HALO_TEST_TOGETHER_API_KEY);
@@ -160,6 +232,8 @@ const controlPlaneTest = test.extend<{
       workspaceProvider,
       traceCloud: traceCloud.cloud(),
       inferenceApiKey,
+      integrationEncryptionKey,
+      getOpenAPISpec,
     });
     if (plane instanceof Error) throw plane;
     await use(plane);
@@ -194,6 +268,233 @@ const controlPlaneTest = test.extend<{
   },
 });
 
+controlPlaneTest(
+  "persists user-bound integration catalogs and native policies after restart",
+  async ({ appDataDir, webRoot, workspaceProvider, integrationApi }) => {
+    const databaseUrl = process.env.HALO_TEST_POSTGRES_URL;
+    const config =
+      databaseUrl === undefined
+        ? {
+            deployment: "local" as const,
+            workspace: { deployment: "local" as const },
+            appDataDir,
+            port: 0,
+            auth: testAuth,
+          }
+        : {
+            deployment: "cloudRun" as const,
+            workspace: {
+              deployment: "gcp" as const,
+              instanceTemplate: "test",
+              projectId: "test",
+              zone: "test",
+            },
+            port: 0,
+            auth: testAuth,
+            databaseUrl,
+            origin: "https://control-plane.example.invalid",
+            traceBucket: "test",
+            workspaceServiceAccount: "test",
+          };
+    const plane = await ControlPlane.start({
+      config,
+      webRoot,
+      workspaceProvider,
+      integrationEncryptionKey,
+      getOpenAPISpec,
+    });
+    if (plane instanceof Error) throw plane;
+    await using cleanup = new errore.AsyncDisposableStack();
+    const lifetime = { open: true };
+    cleanup.defer(async () => {
+      if (lifetime.open) {
+        const closed = await plane.close();
+        if (closed instanceof Error) throw closed;
+      }
+    });
+    const integrations = plane.integrations!;
+    const read = async () =>
+      await integrations.withUser("alice", (executor) =>
+        executor.integrations.list(),
+      );
+    const [first, second] = await Promise.all([read(), read()]);
+    if (first instanceof Error) throw first;
+    expect(second).toEqual(first);
+    expect(first.map((entry) => entry.slug)).toContain("google_gmail");
+    expect(first.map((entry) => entry.slug)).not.toContain("google_meet");
+    const policy = await integrations.withUser("alice", (executor) =>
+      executor.policies.create({
+        owner: Owner.make("user"),
+        pattern: "google_gmail.*",
+        action: "block",
+      }),
+    );
+    if (policy instanceof Error) throw policy;
+    const custom = await integrations.withUser("alice", (executor) =>
+      executor.openapi.addSpec({
+        slug: "private-api",
+        name: "Alice's API",
+        authenticationTemplate: [
+          {
+            type: "apiKey",
+            slug: "token",
+            headers: {
+              Authorization: ["Bearer ", { type: "variable", name: "token" }],
+            },
+          },
+        ],
+        spec: {
+          kind: "blob",
+          value: JSON.stringify({
+            openapi: "3.0.0",
+            info: { title: "Private", version: "1" },
+            servers: [{ url: integrationApi.origin }],
+            paths: {
+              "/items": {
+                get: {
+                  operationId: "listItems",
+                  responses: { "200": { description: "OK" } },
+                },
+              },
+            },
+          }),
+        },
+      }),
+    );
+    if (custom instanceof Error) throw custom;
+    const connection = await integrations.withUser("alice", (executor) =>
+      executor.connections.create({
+        owner: Owner.make("user"),
+        name: ConnectionName.make("personal"),
+        integration: IntegrationSlug.make("private-api"),
+        template: AuthTemplateSlug.make("token"),
+        value: "private-test-token",
+      }),
+    );
+    if (connection instanceof Error) throw connection;
+    expect(
+      await integrations.withUser("bob", (executor) =>
+        executor.policies.list(),
+      ),
+    ).toEqual([]);
+    expect(
+      await integrations.withUser("bob", (executor) =>
+        executor.integrations.get(IntegrationSlug.make("private-api")),
+      ),
+    ).toBeNull();
+    lifetime.open = false;
+    const closed = await plane.close();
+    expect(closed).toBeUndefined();
+    expect(await read()).toBeInstanceOf(Error);
+
+    const reopened = await ControlPlane.start({
+      config,
+      webRoot,
+      workspaceProvider,
+      integrationEncryptionKey,
+      getOpenAPISpec: async () =>
+        new Error("Persisted presets must not fetch again"),
+    });
+    if (reopened instanceof Error) throw reopened;
+    cleanup.defer(async () => {
+      const reopenedClosed = await reopened.close();
+      if (reopenedClosed instanceof Error) throw reopenedClosed;
+    });
+    expect(
+      await reopened.integrations!.withUser("alice", (executor) =>
+        executor.policies.list(),
+      ),
+    ).toEqual([policy]);
+    const persisted = await reopened.integrations!.withUser(
+      "alice",
+      (executor) =>
+        executor.integrations.get(IntegrationSlug.make("private-api")),
+    );
+    expect(persisted).toMatchObject({
+      slug: "private-api",
+      name: "Alice's API",
+    });
+    const invoked = await reopened.integrations!.withUser("alice", (executor) =>
+      executor.execute(
+        ToolAddress.make(`${connection.address}.items.listItems`),
+        {},
+      ),
+    );
+    if (invoked instanceof Error) throw invoked;
+    expect(JSON.stringify(invoked)).toContain("fixture-item");
+    expect(
+      integrationApi.requests.filter((request) => request.url === "/items"),
+    ).toEqual([{ url: "/items", authorization: "Bearer private-test-token" }]);
+  },
+);
+
+controlPlaneTest(
+  "drains accepted integration work and rejects new work during shutdown",
+  async ({ plane }) => {
+    const entered = Promise.withResolvers<void>();
+    const resume = Promise.withResolvers<void>();
+    const work = plane.integrations!.withUser("alice", (executor) =>
+      Effect.gen(function* () {
+        entered.resolve();
+        yield* Effect.promise(async () => await resume.promise);
+        return yield* executor.policies.list();
+      }),
+    );
+    await entered.promise;
+    const closing = plane.integrations!.close();
+    expect(
+      await plane.integrations!.withUser("bob", (executor) =>
+        executor.policies.list(),
+      ),
+    ).toBeInstanceOf(Error);
+    resume.resolve();
+    expect(await work).toEqual([]);
+    expect(await closing).toBeUndefined();
+  },
+);
+
+controlPlaneTest(
+  "releases startup resources when the integration key is invalid",
+  async ({ appDataDir, webRoot, workspaceProvider }) => {
+    const probe = http.createServer();
+    probe.listen(0, "127.0.0.1");
+    await events.once(probe, "listening");
+    // SAFETY: A listening TCP server has AddressInfo, not a pipe address.
+    const port = (probe.address() as AddressInfo).port;
+    await new Promise<void>((resolveClose) =>
+      probe.close(() => resolveClose()),
+    );
+    const config = {
+      deployment: "local" as const,
+      workspace: { deployment: "local" as const },
+      appDataDir,
+      port,
+      auth: testAuth,
+    };
+    const failed = await ControlPlane.start({
+      config,
+      webRoot,
+      workspaceProvider,
+      integrationEncryptionKey: Buffer.alloc(1),
+    });
+    expect(failed).toBeInstanceOf(Error);
+    const retried = await ControlPlane.start({
+      config,
+      webRoot,
+      workspaceProvider,
+      integrationEncryptionKey,
+      getOpenAPISpec,
+    });
+    if (retried instanceof Error) throw retried;
+    await using cleanup = new errore.AsyncDisposableStack();
+    cleanup.defer(async () => {
+      const closed = await retried.close();
+      if (closed instanceof Error) throw closed;
+    });
+    expect((await fetch(`${retried.origin}/health`)).status).toBe(200);
+  },
+);
+
 controlPlaneTest(
   "stays reachable on loopback until closed",
   async ({ appDataDir, webRoot, workspaceProvider }) => {
```

```source-diff:phase1-credential-tests:apps/control-plane/src/credentials/CredentialService.test.ts
diff --git a/apps/control-plane/src/credentials/CredentialService.test.ts b/apps/control-plane/src/credentials/CredentialService.test.ts
new file mode 100644
index 0000000..1657c74
--- /dev/null
+++ b/apps/control-plane/src/credentials/CredentialService.test.ts
@@ -0,0 +1,137 @@
+import { randomBytes } from "node:crypto";
+import fs from "node:fs/promises";
+import { join, resolve } from "node:path";
+import { DatabaseSync } from "node:sqlite";
+import * as errore from "errore";
+import { expect, test } from "vitest";
+import { DatabaseService } from "../DatabaseService.js";
+import {
+  CredentialService,
+  CredentialDecryptionError,
+  InvalidCredentialKeyError,
+} from "./CredentialService.js";
+
+type OpenCredentials = (
+  encryptionKey: Buffer,
+) => Promise<{ db: DatabaseService; credentials: CredentialService }>;
+
+const credentialTest = test.extend<{
+  databasePath: string;
+  openCredentials: OpenCredentials;
+}>({
+  databasePath: async ({ task }, use) => {
+    const parent = resolve(
+      import.meta.dirname,
+      "../../../../tmp/control-plane",
+    );
+    await fs.mkdir(parent, { recursive: true });
+    const directory = await fs.mkdtemp(join(parent, `${task.id}-`));
+    await use(join(directory, "control-plane.db"));
+    await fs.rm(directory, { recursive: true, force: true });
+  },
+  // Each call opens a new connection to the same file, so tests can reopen it.
+  openCredentials: async ({ databasePath }, use) => {
+    await using cleanup = new errore.AsyncDisposableStack();
+
+    await use(async (encryptionKey) => {
+      const db = await DatabaseService.start({
+        type: "sqlite",
+        path: databasePath,
+      });
+      if (db instanceof Error) throw db;
+      cleanup.defer(async () => {
+        if (db.client instanceof DatabaseSync && !db.client.isOpen) return;
+        const closed = await db.close();
+        if (closed instanceof Error) throw closed;
+      });
+
+      const credentials = await CredentialService.start({ db, encryptionKey });
+      if (credentials instanceof Error) throw credentials;
+      return { db, credentials };
+    });
+  },
+});
+
+credentialTest(
+  "persists encrypted credentials across database reopen",
+  async ({ openCredentials, databasePath }) => {
+    const encryptionKey = randomBytes(32);
+    const first = await openCredentials(encryptionKey);
+    expect(
+      await first.credentials.set("user-a", "github", "secret-token-value"),
+    ).toBeUndefined();
+    const closed = await first.db.close();
+    if (closed instanceof Error) throw closed;
+
+    const raw = await fs.readFile(databasePath);
+    expect(raw.includes("secret-token-value")).toBe(false);
+
+    const second = await openCredentials(encryptionKey);
+    expect(await second.credentials.get("user-a", "github")).toBe(
+      "secret-token-value",
+    );
+    expect(await second.credentials.list("user-a")).toEqual(["github"]);
+    expect(await second.credentials.delete("user-a", "github")).toBeUndefined();
+    expect(await second.credentials.get("user-a", "github")).toBeUndefined();
+  },
+);
+
+credentialTest(
+  "keeps each user's credentials separate",
+  async ({ openCredentials }) => {
+    const { credentials } = await openCredentials(randomBytes(32));
+    expect(
+      await credentials.set("alice", "github", "alice-token"),
+    ).toBeUndefined();
+    expect(await credentials.get("bob", "github")).toBeUndefined();
+    expect(await credentials.list("bob")).toEqual([]);
+
+    expect(await credentials.set("bob", "github", "bob-token")).toBeUndefined();
+    expect(await credentials.delete("bob", "github")).toBeUndefined();
+    expect(await credentials.get("alice", "github")).toBe("alice-token");
+  },
+);
+
+credentialTest(
+  "rejects a wrong key or a row moved to another user",
+  async ({ openCredentials }) => {
+    const encryptionKey = randomBytes(32);
+    const { db, credentials } = await openCredentials(encryptionKey);
+    expect(
+      await credentials.set("alice", "github", "alice-token"),
+    ).toBeUndefined();
+
+    const wrongKey = await openCredentials(randomBytes(32));
+    const wrongKeyRead = await wrongKey.credentials.get("alice", "github");
+    expect(wrongKeyRead).toBeInstanceOf(CredentialDecryptionError);
+
+    const client = db.client;
+    if (!(client instanceof DatabaseSync)) throw new Error("expected SQLite");
+    client.exec(
+      "UPDATE credential SET user_id = 'mallory' WHERE user_id = 'alice'",
+    );
+    const movedRead = await credentials.get("mallory", "github");
+    expect(movedRead).toBeInstanceOf(CredentialDecryptionError);
+  },
+);
+
+credentialTest(
+  "requires a 32-byte encryption key",
+  async ({ databasePath }) => {
+    await using cleanup = new errore.AsyncDisposableStack();
+    const db = await DatabaseService.start({
+      type: "sqlite",
+      path: databasePath,
+    });
+    if (db instanceof Error) throw db;
+    cleanup.defer(async () => {
+      await db.close();
+    });
+
+    const started = await CredentialService.start({
+      db,
+      encryptionKey: randomBytes(16),
+    });
+    expect(started).toBeInstanceOf(InvalidCredentialKeyError);
+  },
+);
```

```source-diff:phase1-dependencies:apps/control-plane/package.json
diff --git a/apps/control-plane/package.json b/apps/control-plane/package.json
index e7151b2..f414afd 100644
--- a/apps/control-plane/package.json
+++ b/apps/control-plane/package.json
@@ -17,12 +17,17 @@
   },
   "dependencies": {
     "@better-auth/api-key": "1.7.4",
+    "@executor-js/fumadb": "1.5.7",
+    "@executor-js/plugin-openapi": "1.6.0",
+    "@executor-js/sdk": "1.6.0",
     "@get-halo/client": "workspace:*",
     "@get-halo/config": "workspace:*",
     "@get-halo/shared": "workspace:*",
     "@orpc/server": "2.0.0-beta.29",
     "@sinclair/typebox": "^0.34.52",
     "better-auth": "1.7.4",
+    "drizzle-orm": "0.45.0",
+    "effect": "4.0.0-beta.59",
     "errore": "^0.14.1",
     "google-auth-library": "^11.0.2",
     "httpxy": "^0.5.5",
```

```source-diff:phase1-types:apps/control-plane/tsconfig.json
diff --git a/apps/control-plane/tsconfig.json b/apps/control-plane/tsconfig.json
index b074bbd..6fb419c 100644
--- a/apps/control-plane/tsconfig.json
+++ b/apps/control-plane/tsconfig.json
@@ -1,7 +1,9 @@
 {
   "extends": "@get-halo/typescript-config/base.json",
   "compilerOptions": {
-    "lib": ["ES2023", "ESNext.Disposable"],
+    "module": "ESNext",
+    "moduleResolution": "Bundler",
+    "lib": ["ES2024", "ESNext.Disposable"],
     "noEmit": true,
     "types": ["node", "vitest"]
   },
```


## Historical Phase 2 implementation checkpoint

```source-diff:phase2-service:apps/control-plane/src/integrations/IntegrationService.ts
diff --git a/apps/control-plane/src/integrations/IntegrationService.ts b/apps/control-plane/src/integrations/IntegrationService.ts
index 874b78d..1ff8046 100644
--- a/apps/control-plane/src/integrations/IntegrationService.ts
+++ b/apps/control-plane/src/integrations/IntegrationService.ts
@@ -5,7 +5,14 @@ import {
 } from "@executor-js/plugin-openapi/providers/google";
 import {
   createExecutor,
+  ConnectionNotFoundError,
+  CredentialProviderNotRegisteredError,
+  CredentialResolutionError,
+  ElicitationDeclinedError,
+  ToolBlockedError,
   Effect,
+  isToolResult,
+  parseToolAddress,
   IntegrationSlug,
   ProviderItemId,
   ProviderKey,
@@ -15,7 +22,14 @@ import {
   type CredentialProvider,
   type Executor,
   type ProviderEntry,
+  type Tool,
 } from "@executor-js/sdk/core";
+import type {
+  IntegrationInvocation,
+  IntegrationJson,
+  IntegrationTool,
+  IntegrationToolSchema,
+} from "@get-halo/shared/controlPlaneContract";
 import { Layer } from "effect";
 import { FetchHttpClient } from "effect/unstable/http";
 import * as errore from "errore";
@@ -33,6 +47,11 @@ class IntegrationServiceError extends errore.createTaggedError({
   message: "Integration service failed: $detail",
 }) {}
 
+export class IntegrationToolNotFoundError extends errore.createTaggedError({
+  name: "IntegrationToolNotFoundError",
+  message: "Integration tool not found",
+}) {}
+
 export class IntegrationService {
   // Coalesce first-use initialization per user and drain all work before shutdown.
   private readonly executors = new Map<
@@ -40,6 +59,8 @@ export class IntegrationService {
     Promise<IntegrationExecutor | IntegrationServiceError>
   >();
   private readonly active = new Set<Promise<unknown>>();
+  private readonly activeUsers = new Map<string, number>();
+  private readonly initializing = new Set<string>();
   private closed = false;
   private readonly database: Exclude<
     Awaited<ReturnType<typeof createExecutorDatabase>>,
@@ -107,19 +128,163 @@ export class IntegrationService {
     });
   }
 
-  // Internal boundary only. Phase 2 derives userId from authenticated runtime
-  // state and exposes narrow operations; callers must not retain the executor.
+  async search(ctx: {
+    userId: string;
+    query: string;
+    integration?: string;
+    limit?: number;
+    signal?: AbortSignal;
+  }) {
+    return await this.withUser(
+      ctx.userId,
+      (executor) =>
+        Effect.gen(function* () {
+          const tools = (yield* executor.tools.list({
+            query: ctx.query,
+            integration:
+              ctx.integration === undefined
+                ? undefined
+                : IntegrationSlug.make(ctx.integration),
+          })).filter(isIntegrationTool);
+          const limit = ctx.limit ?? 50;
+          return {
+            tools: tools.slice(0, limit).map(summarizeTool),
+            truncated: tools.length > limit,
+          };
+        }),
+      ctx.signal,
+    );
+  }
+
+  async describe(ctx: {
+    userId: string;
+    address: string;
+    signal?: AbortSignal;
+  }) {
+    return await this.withUser(
+      ctx.userId,
+      (executor) =>
+        Effect.gen(function* () {
+          const tool = yield* resolveTool(executor, ctx.address);
+          if (tool instanceof Error) return tool;
+          const schema = yield* executor.tools.schema(tool.address);
+          if (schema === null) return new IntegrationToolNotFoundError();
+          const json = serializeJson(schema);
+          if (json instanceof Error) return json;
+          // SAFETY: Serialization preserves the SDK schema object's keys and checks JSON compatibility.
+          const wire = json as {
+            inputSchema?: IntegrationJson;
+            outputSchema?: IntegrationJson;
+            schemaDefinitions?: IntegrationJson;
+          };
+          return {
+            ...summarizeTool(tool),
+            inputSchema: wire.inputSchema,
+            outputSchema: wire.outputSchema,
+            schemaDefinitions: wire.schemaDefinitions,
+            requiresApproval: tool.annotations?.requiresApproval,
+          } satisfies IntegrationToolSchema;
+        }),
+      ctx.signal,
+    );
+  }
+
+  async invoke(ctx: {
+    userId: string;
+    address: string;
+    arguments: Record<string, IntegrationJson>;
+    signal?: AbortSignal;
+  }) {
+    const result = await this.withUser(
+      ctx.userId,
+      (executor) =>
+        Effect.gen(function* () {
+          const tool = yield* resolveTool(executor, ctx.address);
+          if (tool instanceof Error) return tool;
+          return yield* executor.execute(tool.address, ctx.arguments).pipe(
+            Effect.match({
+              onFailure: (error): IntegrationInvocation => {
+                if (error instanceof ToolBlockedError)
+                  return { status: "blocked" };
+                if (error instanceof ElicitationDeclinedError)
+                  return { status: "approval_required" };
+                if (
+                  error instanceof CredentialResolutionError ||
+                  error instanceof CredentialProviderNotRegisteredError ||
+                  error instanceof ConnectionNotFoundError
+                )
+                  return { status: "connection_required" };
+                return {
+                  status: "failed",
+                  code: "outcome_unknown",
+                  message:
+                    "Integration invocation failed; do not automatically retry.",
+                };
+              },
+              onSuccess: (value): IntegrationInvocation => {
+                if (isToolResult(value) && !value.ok) {
+                  if (
+                    value.error.code === "connection_rejected" ||
+                    value.error.code === "oauth_scope_insufficient"
+                  )
+                    return { status: "connection_required" };
+                  const timeout =
+                    value.error.code === "upstream_response_headers_timeout" ||
+                    value.error.code === "upstream_response_body_timeout";
+                  return {
+                    status: "failed",
+                    code: timeout ? "outcome_unknown" : "tool_failed",
+                    message: timeout
+                      ? "Integration response timed out; do not automatically retry."
+                      : "The integration reported a tool error.",
+                  };
+                }
+                const json = serializeJson(
+                  isToolResult(value) && value.ok ? value.data : value,
+                );
+                if (json instanceof Error)
+                  return {
+                    status: "failed",
+                    code: "outcome_unknown",
+                    message:
+                      "Integration returned an unsupported result; do not automatically retry.",
+                  };
+                return { status: "completed", result: json };
+              },
+            }),
+          );
+        }),
+      ctx.signal,
+    );
+    if (result instanceof IntegrationToolNotFoundError) return result;
+    if (result instanceof Error)
+      return {
+        status: "failed",
+        code: "outcome_unknown",
+        message:
+          "Integration invocation interrupted or unavailable; do not automatically retry.",
+      } satisfies IntegrationInvocation;
+    return result;
+  }
+
+  // Internal boundary only. RPC callers derive userId from runtime authentication.
+  // Callbacks must not retain the executor.
   async withUser<A, E>(
     userId: string,
     run: (executor: IntegrationExecutor) => Effect.Effect<A, E>,
+    signal?: AbortSignal,
   ) {
     if (this.closed)
       return new IntegrationServiceError({ detail: "service is closed" });
-    const work = this.run(userId, run);
+    this.activeUsers.set(userId, (this.activeUsers.get(userId) ?? 0) + 1);
+    const work = this.run(userId, run, signal);
     this.active.add(work);
     await using cleanup = new errore.AsyncDisposableStack();
     cleanup.defer(() => {
       this.active.delete(work);
+      const count = this.activeUsers.get(userId)! - 1;
+      if (count === 0) this.activeUsers.delete(userId);
+      else this.activeUsers.set(userId, count);
     });
     return await work;
   }
@@ -127,18 +292,57 @@ export class IntegrationService {
   private async run<A, E>(
     userId: string,
     run: (executor: IntegrationExecutor) => Effect.Effect<A, E>,
+    signal?: AbortSignal,
   ) {
     let pending = this.executors.get(userId);
     if (pending === undefined) {
-      pending = this.create(userId);
+      const evicted =
+        this.executors.size >= 100
+          ? [...this.executors.keys()].find(
+              (id) => !this.activeUsers.has(id) && !this.initializing.has(id),
+            )
+          : undefined;
+      if (this.executors.size >= 100 && evicted === undefined)
+        return new IntegrationServiceError({
+          detail: "all Executor slots are busy",
+        });
+      const previous =
+        evicted === undefined ? undefined : this.executors.get(evicted);
+      if (evicted !== undefined) this.executors.delete(evicted);
+      this.initializing.add(userId);
+      pending = (async () => {
+        await using cleanup = new errore.AsyncDisposableStack();
+        cleanup.defer(() => {
+          this.initializing.delete(userId);
+        });
+        const old = await previous;
+        if (old !== undefined && !(old instanceof Error)) {
+          const closed = await Effect.runPromise(old.close()).catch(
+            (cause) =>
+              new IntegrationServiceError({ detail: "evict Executor", cause }),
+          );
+          if (closed instanceof Error) return closed;
+        }
+        return await this.create(userId);
+      })();
       this.executors.set(userId, pending);
     }
-    const executor = await pending;
-    if (executor instanceof Error) {
-      this.executors.delete(userId);
-      return executor;
-    }
-    return await Effect.runPromise(run(executor)).catch(
+    const initialization = pending;
+    const executors = this.executors;
+    return await Effect.runPromise(
+      Effect.gen(function* () {
+        const executor = yield* Effect.promise(
+          async () => await initialization,
+        );
+        if (executor instanceof Error) {
+          if (executors.get(userId) === initialization)
+            executors.delete(userId);
+          return executor;
+        }
+        return yield* run(executor);
+      }).pipe(Effect.timeout("30 seconds")),
+      { signal },
+    ).catch(
       (cause) =>
         new IntegrationServiceError({ detail: "execute operation", cause }),
     );
@@ -153,7 +357,7 @@ export class IntegrationService {
         providers: [this.credentialProvider(userId)],
         plugins: this.plugins,
         onElicitation: () => Effect.succeed({ action: "decline" as const }),
-      }),
+      }).pipe(Effect.timeout("30 seconds")),
     ).catch(
       (cause) =>
         new IntegrationServiceError({ detail: "create Executor", cause }),
@@ -195,7 +399,7 @@ export class IntegrationService {
             ),
             healthCheck: preset.healthCheck,
           });
-        }),
+        }).pipe(Effect.timeout("30 seconds")),
       ).catch(
         (cause) =>
           new IntegrationServiceError({
@@ -262,6 +466,50 @@ export class IntegrationService {
   }
 }
 
+function isIntegrationTool(tool: Tool) {
+  return (
+    tool.static !== true &&
+    tool.pluginId === "openapi" &&
+    parseToolAddress(tool.address) !== null
+  );
+}
+
+function summarizeTool(tool: Tool): IntegrationTool {
+  return {
+    address: tool.address,
+    integration: tool.integration,
+    connection: tool.connection,
+    name: tool.name,
+    description: tool.description,
+  };
+}
+
+function resolveTool(executor: IntegrationExecutor, address: string) {
+  return Effect.gen(function* () {
+    if (parseToolAddress(address) === null)
+      return new IntegrationToolNotFoundError();
+    const tools = yield* executor.tools.list({ includeBlocked: true });
+    return (
+      tools.find(
+        (tool) => tool.address === address && isIntegrationTool(tool),
+      ) ?? new IntegrationToolNotFoundError()
+    );
+  });
+}
+
+// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Executor returns unknown; this is the SDK-to-JSON boundary.
+function serializeJson(value: unknown) {
+  return errore.try({
+    // SAFETY: A successful JSON serialization and parse produces only JSON values.
+    try: () => JSON.parse(JSON.stringify(value)) as IntegrationJson,
+    catch: (cause) =>
+      new IntegrationServiceError({
+        detail: "serialize integration result",
+        cause,
+      }),
+  });
+}
+
 function toEffect<A>(
   label: string,
   run: () => Promise<A | Error>,

```

```source-diff:phase2-router:apps/control-plane/src/server/controlPlaneRpcRouter.ts
diff --git a/apps/control-plane/src/server/controlPlaneRpcRouter.ts b/apps/control-plane/src/server/controlPlaneRpcRouter.ts
index 58fcaa0..0673099 100644
--- a/apps/control-plane/src/server/controlPlaneRpcRouter.ts
+++ b/apps/control-plane/src/server/controlPlaneRpcRouter.ts
@@ -14,14 +14,20 @@ import {
   type AuthService,
   InvalidDesktopAuthCodeError,
   InvalidDesktopSignInRequestError,
+  WorkspaceAuthenticationRequiredError,
 } from "../auth/AuthService.js";
 import type { WorkspaceService } from "../workspace/WorkspaceService.js";
+import {
+  IntegrationToolNotFoundError,
+  type IntegrationService,
+} from "../integrations/IntegrationService.js";
 
 export type ControlPlaneContext = RequestHeadersHandlerPluginContext &
   ResponseHeadersHandlerPluginContext & {
     build?: { version: string; revision: string };
     auth: AuthService;
     workspace: WorkspaceService;
+    integrations?: IntegrationService;
   };
 
 const implementer =
@@ -43,6 +49,29 @@ const os = implementer.use(({ context, next }) => {
   return next();
 });
 
+const loadRuntime = implementer.middleware(async ({ context, next }) => {
+  const identity = await context.workspace.authenticateRuntimeOwner(
+    context.reqHeaders ?? new Headers(),
+  );
+  if (identity instanceof WorkspaceAuthenticationRequiredError)
+    throw new ORPCError("UNAUTHORIZED");
+  if (identity instanceof Error) throw internalError(identity);
+  if (context.integrations === undefined)
+    throw new ORPCError("SERVICE_UNAVAILABLE");
+  return await next({
+    context: {
+      ownerUserId: identity.ownerUserId,
+      integrations: context.integrations,
+    },
+  });
+});
+
+function integrationError(result: Error): never {
+  if (result instanceof IntegrationToolNotFoundError)
+    throw new ORPCError("NOT_FOUND");
+  throw internalError(result);
+}
+
 const getServerInfo = os.server.info.handler(({ context }) => ({
   protocolVersion: controlPlaneProtocolVersion,
   supportedProtocols: controlPlaneSupportedProtocols,
@@ -103,6 +132,41 @@ const ensureWorkspace = os.workspace.ensure
   });
 
 export const controlPlaneRpcRouter = os.router({
+  integrations: os.integrations.router({
+    search: os.integrations.search
+      .use(loadRuntime)
+      .handler(async ({ context, input, signal }) => {
+        const result = await context.integrations.search({
+          ...input,
+          userId: context.ownerUserId,
+          signal,
+        });
+        if (result instanceof Error) return integrationError(result);
+        return result;
+      }),
+    describe: os.integrations.describe
+      .use(loadRuntime)
+      .handler(async ({ context, input, signal }) => {
+        const result = await context.integrations.describe({
+          ...input,
+          userId: context.ownerUserId,
+          signal,
+        });
+        if (result instanceof Error) return integrationError(result);
+        return result;
+      }),
+    invoke: os.integrations.invoke
+      .use(loadRuntime)
+      .handler(async ({ context, input, signal }) => {
+        const result = await context.integrations.invoke({
+          ...input,
+          userId: context.ownerUserId,
+          signal,
+        });
+        if (result instanceof Error) return integrationError(result);
+        return result;
+      }),
+  }),
   server: os.server.router({
     info: getServerInfo,
   }),

```

```source-diff:phase2-contract:packages/shared/src/controlPlaneContract.ts
diff --git a/packages/shared/src/controlPlaneContract.ts b/packages/shared/src/controlPlaneContract.ts
index 02b5c02..2101d05 100644
--- a/packages/shared/src/controlPlaneContract.ts
+++ b/packages/shared/src/controlPlaneContract.ts
@@ -1,6 +1,57 @@
 import * as errore from "errore";
 import { checkServerCompatibility, type ServerInfo } from "@get-halo/client";
 import { error, oc, type, type RouterContractClient } from "@orpc/contract";
+import { Type, type Static, type TSchema } from "@sinclair/typebox";
+import { Value } from "@sinclair/typebox/value";
+
+const jsonValueSchema = Type.Recursive((self) =>
+  Type.Union([
+    Type.Null(),
+    Type.Boolean(),
+    Type.Number(),
+    Type.String(),
+    Type.Array(self),
+    Type.Record(Type.String(), self),
+  ]),
+);
+export type IntegrationJson = Static<typeof jsonValueSchema>;
+export type IntegrationTool = {
+  address: string;
+  integration: string;
+  connection: string;
+  name: string;
+  description: string;
+};
+export type IntegrationToolSchema = IntegrationTool & {
+  inputSchema?: IntegrationJson;
+  outputSchema?: IntegrationJson;
+  schemaDefinitions?: IntegrationJson;
+  requiresApproval?: boolean;
+};
+export type IntegrationInvocation =
+  | { status: "completed"; result: IntegrationJson }
+  | { status: "blocked" | "approval_required" | "connection_required" }
+  | {
+      status: "failed";
+      code: "tool_failed" | "unsupported_interaction" | "outcome_unknown";
+      message: string;
+    };
+
+function validated<T extends TSchema>(schema: T) {
+  return {
+    "~standard": {
+      version: 1 as const,
+      vendor: "halo-typebox",
+      validate: (
+        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Standard Schema receives untrusted RPC input here.
+        value: unknown,
+      ): { value: Static<T> } | { issues: { message: string }[] } =>
+        Value.Check(schema, value)
+          ? { value }
+          : { issues: [{ message: "Invalid integration request" }] },
+    },
+  };
+}
 
 export const controlPlaneProtocolVersion = 3 as const;
 export const controlPlaneSupportedProtocols = [controlPlaneProtocolVersion];
@@ -69,6 +120,49 @@ export const controlPlaneContract = publicProcedure.router({
     rotateRuntimeToken:
       authenticatedProcedure.output(type<ControlPlaneWorkspace>()),
   },
+  integrations: {
+    search: authenticatedProcedure
+      .input(
+        validated(
+          Type.Object(
+            {
+              query: Type.String({ maxLength: 1024 }),
+              integration: Type.Optional(
+                Type.String({ minLength: 1, maxLength: 256 }),
+              ),
+              limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
+            },
+            { additionalProperties: false },
+          ),
+        ),
+      )
+      .output(type<{ tools: IntegrationTool[]; truncated: boolean }>()),
+    describe: authenticatedProcedure
+      .input(
+        validated(
+          Type.Object(
+            {
+              address: Type.String({ minLength: 1, maxLength: 2048 }),
+            },
+            { additionalProperties: false },
+          ),
+        ),
+      )
+      .output(type<IntegrationToolSchema>()),
+    invoke: authenticatedProcedure
+      .input(
+        validated(
+          Type.Object(
+            {
+              address: Type.String({ minLength: 1, maxLength: 2048 }),
+              arguments: Type.Record(Type.String(), jsonValueSchema),
+            },
+            { additionalProperties: false },
+          ),
+        ),
+      )
+      .output(type<IntegrationInvocation>()),
+  },
 });
 
 export type ControlPlaneClient = RouterContractClient<

```

```source-diff:phase2-auth:apps/control-plane/src/workspace/WorkspaceService.ts
diff --git a/apps/control-plane/src/workspace/WorkspaceService.ts b/apps/control-plane/src/workspace/WorkspaceService.ts
index 726bc83..9f13a2c 100644
--- a/apps/control-plane/src/workspace/WorkspaceService.ts
+++ b/apps/control-plane/src/workspace/WorkspaceService.ts
@@ -145,7 +145,7 @@ export class WorkspaceService {
     return { workspaceId: identity.workspaceId };
   }
 
-  private async authenticateRuntimeOwner(headers: Headers) {
+  async authenticateRuntimeOwner(headers: Headers) {
     const identity = await this.auth.verifyWorkspaceToken(headers);
     if (identity instanceof Error) return identity;
     const workspace = await this.findRecord(identity.userId);

```

```source-diff:phase2-http:apps/control-plane/src/server/controlPlaneHttp.ts
diff --git a/apps/control-plane/src/server/controlPlaneHttp.ts b/apps/control-plane/src/server/controlPlaneHttp.ts
index 992a6a3..eb3c6d3 100644
--- a/apps/control-plane/src/server/controlPlaneHttp.ts
+++ b/apps/control-plane/src/server/controlPlaneHttp.ts
@@ -32,6 +32,7 @@ import {
 } from "./controlPlaneRpcRouter.js";
 import type { TraceIngestion } from "../traces/TraceIngestion.js";
 import type { WorkspaceService } from "../workspace/WorkspaceService.js";
+import type { IntegrationService } from "../integrations/IntegrationService.js";
 import {
   isWorkspaceProxyRequest,
   WorkspaceGateway,
@@ -100,6 +101,7 @@ export function serveControlPlaneHttp(ctx: {
   auth: AuthService;
   publicOrigin: string;
   workspace: WorkspaceService;
+  integrations?: IntegrationService;
   build?: { version: string; revision: string };
   webRoot: string;
   traces?: TraceIngestion;
@@ -141,6 +143,7 @@ export function serveControlPlaneHttp(ctx: {
       gateway,
       traces,
       rpc,
+      integrations: ctx.integrations,
       webRoot,
       build: ctx.build,
       inferenceApiKey: ctx.inferenceApiKey,
@@ -205,6 +208,7 @@ async function routeControlPlaneRequest(ctx: {
   traces?: TraceIngestion;
   inferenceApiKey?: string;
   workspace: WorkspaceService;
+  integrations?: IntegrationService;
   build?: { version: string; revision: string };
   rpc: RPCHandler<ControlPlaneContext>;
   webRoot: string;
@@ -303,6 +307,7 @@ async function routeControlPlaneRequest(ctx: {
       auth,
       workspace,
       rpc,
+      integrations: ctx.integrations,
       build: ctx.build,
     });
     return;
@@ -440,13 +445,19 @@ async function serveControlPlaneRpc(ctx: {
   response: ServerResponse;
   auth: AuthService;
   workspace: WorkspaceService;
+  integrations?: IntegrationService;
   build?: { version: string; revision: string };
   rpc: RPCHandler<ControlPlaneContext>;
 }) {
   const { request, response, auth, workspace, rpc } = ctx;
   const handled = await rpc.handle(request, response, {
     prefix: "/rpc",
-    context: { auth, workspace, build: ctx.build },
+    context: {
+      auth,
+      workspace,
+      integrations: ctx.integrations,
+      build: ctx.build,
+    },
   });
 
   if (handled.matched) return;

```

```source-diff:phase2-host:apps/control-plane/src/server/ControlPlane.ts
diff --git a/apps/control-plane/src/server/ControlPlane.ts b/apps/control-plane/src/server/ControlPlane.ts
index 47168d2..871b497 100644
--- a/apps/control-plane/src/server/ControlPlane.ts
+++ b/apps/control-plane/src/server/ControlPlane.ts
@@ -128,6 +128,7 @@ export class ControlPlane {
       auth,
       publicOrigin,
       workspace,
+      integrations,
       webRoot,
       build: ctx.build,
       inferenceApiKey: ctx.inferenceApiKey,

```

```source-diff:phase2-tests:apps/control-plane/test/ControlPlane.test.ts
diff --git a/apps/control-plane/test/ControlPlane.test.ts b/apps/control-plane/test/ControlPlane.test.ts
index 2dfafcf..fe7973d 100644
--- a/apps/control-plane/test/ControlPlane.test.ts
+++ b/apps/control-plane/test/ControlPlane.test.ts
@@ -142,6 +142,7 @@ const controlPlaneTest = test.extend<{
   integrationApi: {
     origin: string;
     requests: { url: string | undefined; authorization: string | undefined }[];
+    disconnected: string[];
   };
 }>({
   // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
@@ -150,11 +151,32 @@ const controlPlaneTest = test.extend<{
       url: string | undefined;
       authorization: string | undefined;
     }[] = [];
+    const disconnected: string[] = [];
     const server = http.createServer((request, response) => {
       requests.push({
         url: request.url,
         authorization: request.headers.authorization,
       });
+      if (request.url === "/lost") {
+        request.socket.destroy();
+        return;
+      }
+      if (request.url === "/slow") {
+        response.once("close", () => disconnected.push("/slow"));
+        return;
+      }
+      if (request.url === "/error") {
+        response
+          .writeHead(500, { "content-type": "application/json" })
+          .end(JSON.stringify({ error: "provider failed" }));
+        return;
+      }
+      if (request.url?.startsWith("/mutations/")) {
+        response
+          .writeHead(200, { "content-type": "application/json" })
+          .end(JSON.stringify({ written: request.url.split("/").at(-1) }));
+        return;
+      }
       if (request.url !== "/items") {
         response.writeHead(404).end();
         return;
@@ -176,7 +198,11 @@ const controlPlaneTest = test.extend<{
     });
     // SAFETY: A listening TCP server has AddressInfo, not a pipe address.
     const address = server.address() as AddressInfo;
-    await use({ origin: `http://127.0.0.1:${address.port}`, requests });
+    await use({
+      origin: `http://127.0.0.1:${address.port}`,
+      requests,
+      disconnected,
+    });
   },
   // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
   inferenceApiKey: async ({}, use) => {
@@ -268,6 +294,307 @@ const controlPlaneTest = test.extend<{
   },
 });
 
+controlPlaneTest(
+  "discovers and invokes only the runtime owner's integration tools through RPC",
+  async ({
+    plane,
+    authenticatedRpc,
+    rpc,
+    browserHeaders,
+    appDataDir,
+    integrationApi,
+  }) => {
+    await authenticatedRpc.workspace.ensure();
+    const runtime = await readRuntimeSettings(appDataDir);
+    const client = createControlPlaneRpcClient(plane.origin, runtime.token);
+    const session = await authenticatedRpc.auth.session();
+    if (session.status !== "signed-in") throw new Error("Missing test session");
+    const userId = session.session.user.id;
+    const setup = await plane.integrations!.withUser(userId, (executor) =>
+      Effect.gen(function* () {
+        yield* executor.openapi.addSpec({
+          slug: "rpc-api",
+          name: "RPC fixture",
+          authenticationTemplate: [
+            {
+              type: "apiKey",
+              slug: "token",
+              headers: {
+                Authorization: ["Bearer ", { type: "variable", name: "token" }],
+              },
+            },
+          ],
+          spec: {
+            kind: "blob",
+            value: JSON.stringify({
+              openapi: "3.0.0",
+              info: { title: "RPC fixture", version: "1" },
+              servers: [{ url: integrationApi.origin }],
+              paths: {
+                "/mutations/{id}": {
+                  post: {
+                    operationId: "write",
+                    description: "Write a mutation",
+                    parameters: [
+                      {
+                        name: "id",
+                        in: "path",
+                        required: true,
+                        schema: { type: "string" },
+                      },
+                    ],
+                    responses: { "200": { description: "OK" } },
+                  },
+                },
+                "/lost": {
+                  post: {
+                    operationId: "loseResponse",
+                    responses: { "200": { description: "OK" } },
+                  },
+                },
+                "/error": {
+                  post: {
+                    operationId: "fail",
+                    responses: { "200": { description: "OK" } },
+                  },
+                },
+                "/slow": {
+                  post: {
+                    operationId: "wait",
+                    responses: { "200": { description: "OK" } },
+                  },
+                },
+              },
+            }),
+          },
+        });
+        return yield* executor.connections.create({
+          owner: Owner.make("user"),
+          name: ConnectionName.make("personal"),
+          integration: IntegrationSlug.make("rpc-api"),
+          template: AuthTemplateSlug.make("token"),
+          value: "rpc-test-token",
+        });
+      }),
+    );
+    if (setup instanceof Error) throw setup;
+    const discovered = await client.integrations.search({ query: "MUTATION" });
+    expect(discovered.tools).toHaveLength(1);
+    const address = discovered.tools[0]!.address;
+    expect(discovered).toMatchObject({
+      truncated: false,
+      tools: [
+        {
+          integration: "rpc-api",
+          connection: "personal",
+          description: "Write a mutation",
+        },
+      ],
+    });
+    const schema = await client.integrations.describe({ address });
+    expect(schema).toMatchObject({
+      address,
+      inputSchema: {
+        type: "object",
+        properties: { id: { type: "string" } },
+        required: ["id"],
+      },
+    });
+    const limited = await client.integrations.search({
+      query: "",
+      integration: "rpc-api",
+      limit: 1,
+    });
+    expect(limited.tools).toHaveLength(1);
+    expect(limited.truncated).toBe(true);
+
+    for (const unauthorized of [
+      rpc,
+      authenticatedRpc,
+      createControlPlaneRpcClient(plane.origin, browserHeaders),
+    ]) {
+      await expect(
+        unauthorized.integrations.search({ query: "" }),
+      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
+      await expect(
+        unauthorized.integrations.describe({ address }),
+      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
+      await expect(
+        unauthorized.integrations.invoke({
+          address,
+          arguments: { id: "unauthorized" },
+        }),
+      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
+    }
+    await expect(
+      client.integrations.search({ query: "", limit: 101 }),
+    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
+    // A forged owner must be rejected, not accepted as extra routing metadata.
+    const forged = { query: "", userId: "someone-else" };
+    await expect(client.integrations.search(forged)).rejects.toMatchObject({
+      code: "BAD_REQUEST",
+    });
+    for (const forbidden of [
+      "executor.policies.create",
+      "executor.openapi.addSpec",
+    ]) {
+      await expect(
+        client.integrations.describe({ address: forbidden }),
+      ).rejects.toMatchObject({ code: "NOT_FOUND" });
+      await expect(
+        client.integrations.invoke({ address: forbidden, arguments: {} }),
+      ).rejects.toMatchObject({ code: "NOT_FOUND" });
+    }
+    const bobHeaders = await createAuthenticatedHeaders(
+      appDataDir,
+      plane.origin,
+      "integration-bob@example.com",
+    );
+    await createControlPlaneRpcClient(
+      plane.origin,
+      bobHeaders,
+    ).workspace.ensure();
+    const bobRuntime = await readRuntimeSettings(appDataDir);
+    const bob = createControlPlaneRpcClient(plane.origin, bobRuntime.token);
+    expect(
+      await bob.integrations.search({ query: "", integration: "rpc-api" }),
+    ).toEqual({ tools: [], truncated: false });
+    await expect(bob.integrations.describe({ address })).rejects.toMatchObject({
+      code: "NOT_FOUND",
+    });
+    await expect(
+      bob.integrations.invoke({ address, arguments: { id: "stolen" } }),
+    ).rejects.toMatchObject({ code: "NOT_FOUND" });
+    expect(
+      integrationApi.requests.filter((request) =>
+        request.url?.startsWith("/mutations/"),
+      ),
+    ).toEqual([]);
+
+    expect(
+      await client.integrations.invoke({
+        address,
+        arguments: { id: "no-policy" },
+      }),
+    ).toEqual({ status: "approval_required" });
+    const allowed = await plane.integrations!.withUser(userId, (executor) =>
+      executor.policies.create({
+        owner: Owner.make("user"),
+        pattern: "rpc-api.*",
+        action: "approve",
+      }),
+    );
+    if (allowed instanceof Error) throw allowed;
+    expect(
+      await client.integrations.invoke({
+        address,
+        arguments: { id: "accepted-17" },
+      }),
+    ).toEqual({ status: "completed", result: { written: "accepted-17" } });
+    const invalid = await client.integrations.invoke({
+      address,
+      arguments: { id: "invalid", unexpected: true },
+    });
+    expect(invalid.status).toBe("failed");
+    const policy = await plane.integrations!.withUser(userId, (executor) =>
+      executor.policies.create({
+        owner: Owner.make("user"),
+        pattern: address.slice("tools.".length),
+        action: "block",
+      }),
+    );
+    if (policy instanceof Error) throw policy;
+    expect(
+      await client.integrations.invoke({
+        address,
+        arguments: { id: "blocked" },
+      }),
+    ).toEqual({ status: "blocked" });
+    expect(await client.integrations.search({ query: "MUTATION" })).toEqual({
+      tools: [],
+      truncated: false,
+    });
+    await expect(
+      client.integrations.describe({ address }),
+    ).rejects.toMatchObject({ code: "NOT_FOUND" });
+    const changed = await plane.integrations!.withUser(userId, (executor) =>
+      executor.policies.update({
+        id: policy.id,
+        owner: Owner.make("user"),
+        action: "require_approval",
+      }),
+    );
+    if (changed instanceof Error) throw changed;
+    expect(
+      await client.integrations.invoke({
+        address,
+        arguments: { id: "unapproved" },
+      }),
+    ).toEqual({ status: "approval_required" });
+    expect(
+      integrationApi.requests.filter((request) =>
+        request.url?.startsWith("/mutations/"),
+      ),
+    ).toEqual([
+      { url: "/mutations/accepted-17", authorization: "Bearer rpc-test-token" },
+    ]);
+
+    const tools = await client.integrations.search({
+      query: "",
+      integration: "rpc-api",
+    });
+    const lost = tools.tools.find((tool) =>
+      tool.name.includes("loseResponse"),
+    )!;
+    expect(
+      await client.integrations.invoke({
+        address: lost.address,
+        arguments: {},
+      }),
+    ).toMatchObject({ status: "failed", code: "outcome_unknown" });
+    expect(
+      integrationApi.requests.filter((request) => request.url === "/lost"),
+    ).toHaveLength(1);
+    const failed = tools.tools.find((tool) => tool.name.endsWith("fail"))!;
+    expect(
+      await client.integrations.invoke({
+        address: failed.address,
+        arguments: {},
+      }),
+    ).toMatchObject({ status: "failed", code: "tool_failed" });
+    const slow = tools.tools.find((tool) => tool.name.endsWith("wait"))!;
+    const controller = new AbortController();
+    const waiting = client.integrations.invoke(
+      { address: slow.address, arguments: {} },
+      { signal: controller.signal },
+    );
+    const cancelled = expect(waiting).rejects.toThrow();
+    await expect
+      .poll(
+        () =>
+          integrationApi.requests.filter((request) => request.url === "/slow")
+            .length,
+      )
+      .toBe(1);
+    controller.abort();
+    await cancelled;
+    await expect.poll(() => integrationApi.disconnected).toEqual(["/slow"]);
+    await authenticatedRpc.workspace.rotateRuntimeToken();
+    await expect(
+      client.integrations.invoke({ address, arguments: { id: "rotated" } }),
+    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
+    const rotated = await readRuntimeSettings(appDataDir);
+    expect(
+      (
+        await createControlPlaneRpcClient(
+          plane.origin,
+          rotated.token,
+        ).integrations.search({ query: "MUTATION" })
+      ).tools,
+    ).toHaveLength(1);
+  },
+);
+
 controlPlaneTest(
   "persists user-bound integration catalogs and native policies after restart",
   async ({ appDataDir, webRoot, workspaceProvider, integrationApi }) => {

```


## Current local implementation patches

Generated from the current working-tree changes against HEAD; historical checkpoints above are unchanged. Scratch browser harnesses are excluded.


```source-diff:automatic-approval:apps/control-plane/src/integrations/IntegrationService.ts
diff --git a/apps/control-plane/src/integrations/IntegrationService.ts b/apps/control-plane/src/integrations/IntegrationService.ts
index 874b78d..356843b 100644
--- a/apps/control-plane/src/integrations/IntegrationService.ts
+++ b/apps/control-plane/src/integrations/IntegrationService.ts
@@ -1,3 +1,11 @@
+import crypto from "node:crypto";
+import dns from "node:dns/promises";
+import http from "node:http";
+import https from "node:https";
+import stream from "node:stream";
+import zlib from "node:zlib";
+import { DatabaseSync } from "node:sqlite";
+import { mcpPlugin } from "@executor-js/plugin-mcp/core";
 import { openApiPlugin } from "@executor-js/plugin-openapi/core";
 import {
   googleCatalog,
@@ -5,8 +13,20 @@ import {
 } from "@executor-js/plugin-openapi/providers/google";
 import {
   createExecutor,
+  ConnectionNotFoundError,
+  CredentialProviderNotRegisteredError,
+  CredentialResolutionError,
+  ElicitationDeclinedError,
+  ToolBlockedError,
   Effect,
+  isToolResult,
+  parseToolAddress,
   IntegrationSlug,
+  AuthTemplateSlug,
+  ConnectionName,
+  OAuthClientSlug,
+  OAuthState,
+  Owner,
   ProviderItemId,
   ProviderKey,
   StorageError,
@@ -15,17 +35,33 @@ import {
   type CredentialProvider,
   type Executor,
   type ProviderEntry,
+  type Tool,
+  type Integration,
+  type Connection,
+  type FirstPartyOAuthClientConfig,
 } from "@executor-js/sdk/core";
+import type {
+  IntegrationConnection,
+  IntegrationInvocation,
+  IntegrationJson,
+  IntegrationTool,
+  IntegrationToolSchema,
+  IntegrationSetup,
+  IntegrationSetupCatalogEntry,
+} from "@get-halo/shared/controlPlaneContract";
 import { Layer } from "effect";
 import { FetchHttpClient } from "effect/unstable/http";
 import * as errore from "errore";
 import type { CredentialService } from "../credentials/CredentialService.js";
-import type { DatabaseService } from "../DatabaseService.js";
+import type { DatabaseService, DatabaseClient } from "../DatabaseService.js";
 import { createExecutorDatabase } from "./createExecutorDatabase.js";
 
 // Executor 1.6 rewrites Meet's Discovery URL to a legacy endpoint returning 404.
 const presets = googleCatalog.filter((preset) => preset.id !== "google-meet");
-type IntegrationPlugins = readonly [ReturnType<typeof openApiPlugin>];
+type IntegrationPlugins = readonly [
+  ReturnType<typeof openApiPlugin>,
+  ReturnType<typeof mcpPlugin>,
+];
 type IntegrationExecutor = Executor<IntegrationPlugins>;
 
 class IntegrationServiceError extends errore.createTaggedError({
@@ -33,6 +69,25 @@ class IntegrationServiceError extends errore.createTaggedError({
   message: "Integration service failed: $detail",
 }) {}
 
+export class IntegrationToolNotFoundError extends errore.createTaggedError({
+  name: "IntegrationToolNotFoundError",
+  message: "Integration tool not found",
+}) {}
+
+export class IntegrationSetupError extends errore.createTaggedError({
+  name: "IntegrationSetupError",
+  message: "$detail",
+}) {}
+
+type SetupRow = {
+  setup_id: string;
+  user_id: string;
+  data: string;
+  status: IntegrationSetup["status"];
+  expires_at: number;
+  oauth_state?: string;
+};
+
 export class IntegrationService {
   // Coalesce first-use initialization per user and drain all work before shutdown.
   private readonly executors = new Map<
@@ -40,6 +95,8 @@ export class IntegrationService {
     Promise<IntegrationExecutor | IntegrationServiceError>
   >();
   private readonly active = new Set<Promise<unknown>>();
+  private readonly activeUsers = new Map<string, number>();
+  private readonly initializing = new Set<string>();
   private closed = false;
   private readonly database: Exclude<
     Awaited<ReturnType<typeof createExecutorDatabase>>,
@@ -47,6 +104,10 @@ export class IntegrationService {
   >;
   private readonly credentials: CredentialService;
   private readonly plugins: IntegrationPlugins;
+  private readonly setupDb: DatabaseClient;
+  private readonly publicOrigin: string;
+  private readonly firstPartyOAuthClients: readonly FirstPartyOAuthClientConfig[];
+  private readonly allowLocalUrls: boolean;
 
   private constructor(ctx: {
     database: Exclude<
@@ -55,9 +116,17 @@ export class IntegrationService {
     >;
     credentials: CredentialService;
     getOpenAPISpec?: (url: string) => Promise<string | Error>;
+    setupDb: DatabaseClient;
+    publicOrigin: string;
+    firstPartyOAuthClients?: readonly FirstPartyOAuthClientConfig[];
+    allowLocalUrls?: boolean;
   }) {
     this.database = ctx.database;
     this.credentials = ctx.credentials;
+    this.setupDb = ctx.setupDb;
+    this.publicOrigin = ctx.publicOrigin;
+    this.firstPartyOAuthClients = ctx.firstPartyOAuthClients ?? [];
+    this.allowLocalUrls = ctx.allowLocalUrls ?? false;
     const getOpenAPISpec = ctx.getOpenAPISpec;
     // Only spec loading is overridden. Tool invocations keep Executor's normal HTTP client.
     const httpClientLayer =
@@ -80,6 +149,7 @@ export class IntegrationService {
     this.plugins = [
       openApiPlugin({
         presets,
+        httpClientLayer: this.safeHttpLayer(),
         specFormats: [
           httpClientLayer === undefined
             ? googleDiscoveryAdapter
@@ -90,6 +160,8 @@ export class IntegrationService {
               },
         ],
       }),
+      // Remote HTTP/SSE only: never spawn user-supplied processes in the control plane.
+      mcpPlugin({ httpClientLayer: this.safeHttpLayer() }),
     ];
   }
 
@@ -97,29 +169,785 @@ export class IntegrationService {
     db: DatabaseService;
     credentials: CredentialService;
     getOpenAPISpec?: (url: string) => Promise<string | Error>;
+    publicOrigin: string;
+    firstPartyOAuthClients?: readonly FirstPartyOAuthClientConfig[];
+    allowLocalUrls?: boolean;
   }) {
     const database = await createExecutorDatabase(ctx.db);
     if (database instanceof Error) return database;
-    return new IntegrationService({
+    const service = new IntegrationService({
       database,
       credentials: ctx.credentials,
       getOpenAPISpec: ctx.getOpenAPISpec,
+      setupDb: ctx.db.client,
+      publicOrigin: ctx.publicOrigin,
+      firstPartyOAuthClients: ctx.firstPartyOAuthClients,
+      allowLocalUrls: ctx.allowLocalUrls,
+    });
+    const initialized = await service.sql(
+      "CREATE TABLE IF NOT EXISTS halo_integration_setup (setup_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, integration TEXT NOT NULL, connection_name TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, expires_at BIGINT NOT NULL, oauth_state TEXT)",
+    );
+    if (initialized instanceof Error) return initialized;
+    const indexed = await service.sql(
+      "CREATE UNIQUE INDEX IF NOT EXISTS halo_integration_setup_state ON halo_integration_setup (oauth_state) WHERE oauth_state NOT IN ('submitting','consuming')",
+    );
+    if (indexed instanceof Error) return indexed;
+    const names = await service.sql(
+      "CREATE UNIQUE INDEX IF NOT EXISTS halo_integration_setup_name ON halo_integration_setup (user_id,integration,connection_name) WHERE status IN ('authorizing','ready')",
+    );
+    if (names instanceof Error) return names;
+    return service;
+  }
+
+  private async sql(query: string, params: (string | number)[] = []) {
+    const db = this.setupDb;
+    if (db instanceof DatabaseSync)
+      return errore.try({
+        // SAFETY: Every row-returning query below selects the service-owned setup table.
+        try: () =>
+          db.prepare(query.replace(/\$\d+/g, "?")).all(...params) as SetupRow[],
+        catch: (cause) =>
+          new IntegrationServiceError({ detail: "persist setup", cause }),
+      });
+    return await db
+      .query<SetupRow>(query, params)
+      .then((result) => result.rows)
+      .catch(
+        (cause) =>
+          new IntegrationServiceError({ detail: "persist setup", cause }),
+      );
+  }
+
+  async catalog(userId: string) {
+    return await this.withUser(userId, (executor) =>
+      Effect.map(executor.integrations.list(), (integrations) =>
+        integrations.map(setupCatalogEntry),
+      ),
+    );
+  }
+
+  async startSetup(ctx: {
+    userId: string;
+    integration: string;
+    connectionName?: string;
+  }) {
+    const catalog = await this.catalog(ctx.userId);
+    if (catalog instanceof Error) return catalog;
+    const entry = catalog.find(
+      (candidate) => candidate.integration === ctx.integration,
+    );
+    if (entry === undefined)
+      return new IntegrationSetupError({ detail: "Integration not found" });
+    const setupId = crypto.randomUUID();
+    const setup: IntegrationSetup = {
+      ...entry,
+      setupId,
+      connectionName:
+        ctx.connectionName ??
+        `connection${crypto.randomBytes(6).toString("hex")}`,
+      status: "awaiting_credentials",
+    };
+    const saved = await this.sql(
+      "INSERT INTO halo_integration_setup (setup_id,user_id,data,status,expires_at,integration,connection_name) VALUES ($1,$2,$3,$4,$5,$6,$7)",
+      [
+        setupId,
+        ctx.userId,
+        JSON.stringify(setup),
+        setup.status,
+        Date.now() + 15 * 60 * 1000,
+        setup.integration,
+        setup.connectionName,
+      ],
+    );
+    if (saved instanceof Error) return saved;
+    return { setupId, setupUrl: this.setupUrl(setupId) };
+  }
+
+  private setupUrl(setupId: string) {
+    return `${this.publicOrigin}/integrations/setup/${encodeURIComponent(setupId)}`;
+  }
+
+  async setup(ctx: { userId: string; setupId: string }) {
+    const expired = await this.sql(
+      "UPDATE halo_integration_setup SET status='expired', oauth_state=NULL WHERE setup_id=$1 AND user_id=$2 AND expires_at <= $3 AND status IN ('awaiting_credentials','authorizing') AND (oauth_state IS NULL OR oauth_state NOT IN ('submitting','consuming') OR expires_at <= $4) RETURNING *",
+      [ctx.setupId, ctx.userId, Date.now(), Date.now() - 30_000],
+    );
+    if (expired instanceof Error) return expired;
+    const rows = await this.sql(
+      "SELECT * FROM halo_integration_setup WHERE setup_id=$1 AND user_id=$2",
+      [ctx.setupId, ctx.userId],
+    );
+    if (rows instanceof Error) return rows;
+    const row = rows[0];
+    if (row === undefined)
+      return new IntegrationSetupError({ detail: "Setup not found" });
+    const parsed = errore.try({
+      // SAFETY: Only this service writes data, serializing IntegrationSetup without credentials.
+      try: () => JSON.parse(row.data) as IntegrationSetup,
+      catch: (cause) =>
+        new IntegrationServiceError({ detail: "read setup", cause }),
+    });
+    if (parsed instanceof Error) return parsed;
+    return { ...parsed, status: row.status };
+  }
+
+  async submitSetup(ctx: {
+    userId: string;
+    setupId: string;
+    template: string;
+    values?: Record<string, string>;
+  }) {
+    const setup = await this.setup(ctx);
+    if (setup instanceof Error) return setup;
+    if (setup.status !== "awaiting_credentials")
+      return new IntegrationSetupError({
+        detail: "Setup is no longer awaiting credentials",
+      });
+    const method = setup.methods.find(
+      (candidate) => candidate.template === ctx.template,
+    );
+    if (method === undefined)
+      return new IntegrationSetupError({
+        detail: "Unknown authentication method",
+      });
+    const values = ctx.values ?? {};
+    if (
+      Object.keys(values).some((key) => !method.fields.includes(key)) ||
+      method.fields.some((key) => !values[key])
+    )
+      return new IntegrationSetupError({
+        detail: "Supply only the required credential fields",
+      });
+    const claimed = await this.sql(
+      "UPDATE halo_integration_setup SET status='authorizing',oauth_state='submitting' WHERE setup_id=$1 AND user_id=$2 AND status='awaiting_credentials' AND expires_at > $3 AND NOT EXISTS (SELECT 1 FROM halo_integration_setup other WHERE other.user_id=$4 AND other.integration=$5 AND other.connection_name=$6 AND other.status IN ('authorizing','ready')) RETURNING *",
+      [
+        ctx.setupId,
+        ctx.userId,
+        Date.now(),
+        ctx.userId,
+        setup.integration,
+        setup.connectionName,
+      ],
+    );
+    if (claimed instanceof Error) return claimed;
+    if (claimed.length === 0)
+      return new IntegrationSetupError({
+        detail:
+          "Setup is no longer awaiting credentials or its connection name is already taken",
+      });
+    const redirectUri = `${this.publicOrigin}/api/integrations/oauth/callback`;
+    const result = await this.withUser(ctx.userId, (executor) =>
+      Effect.gen(function* () {
+        const integration = yield* executor.integrations.get(
+          IntegrationSlug.make(setup.integration),
+        );
+        if (integration === null)
+          return new IntegrationSetupError({ detail: "Integration not found" });
+        const input = {
+          owner: Owner.make("user"),
+          name: ConnectionName.make(setup.connectionName),
+          integration: integration.slug,
+          template: AuthTemplateSlug.make(ctx.template),
+        };
+        const existing = yield* executor.connections.get(input);
+        if (existing !== null)
+          return new IntegrationSetupError({
+            detail: "Connection name is already taken",
+          });
+        if (method.kind !== "oauth")
+          return {
+            status: "connected" as const,
+            connection: yield* executor.connections.create({
+              ...input,
+              values,
+            }),
+          };
+        const descriptor = integration.authMethods.find(
+          (item) => item.template === ctx.template,
+        )?.oauth;
+        const clients = yield* executor.oauth.listClients();
+        const client = clients.find(
+          (candidate) =>
+            candidate.authorizationUrl === descriptor?.authorizationUrl &&
+            candidate.tokenUrl === descriptor?.tokenUrl,
+        );
+        const discovered =
+          client === undefined && descriptor?.discoveryUrl !== undefined
+            ? yield* executor.oauth.probe({ url: descriptor.discoveryUrl })
+            : undefined;
+        const matching =
+          client ??
+          clients.find(
+            (candidate) =>
+              candidate.authorizationUrl === discovered?.authorizationUrl &&
+              candidate.tokenUrl === discovered?.tokenUrl,
+          );
+        const slug =
+          matching?.slug ??
+          (!discovered?.registrationEndpoint
+            ? undefined
+            : yield* executor.oauth.registerDynamicClient({
+                owner: Owner.make("user"),
+                slug: OAuthClientSlug.make(`setup-${setup.setupId}`),
+                issuer: discovered.issuer,
+                registrationEndpoint: discovered.registrationEndpoint,
+                authorizationUrl: discovered.authorizationUrl,
+                tokenUrl: discovered.tokenUrl,
+                resource: discovered.resource,
+                scopes: discovered.scopesSupported ?? [],
+                tokenEndpointAuthMethodsSupported:
+                  discovered.tokenEndpointAuthMethodsSupported,
+                redirectUri,
+                originIntegration: integration.slug,
+                clientName: "Halo",
+              }));
+        if (slug === undefined)
+          return new IntegrationSetupError({
+            detail:
+              "No configured OAuth client matches this integration; the server does not support dynamic registration",
+          });
+        return yield* executor.oauth.start({
+          ...input,
+          client: slug,
+          clientOwner: matching?.owner ?? Owner.make("user"),
+          redirectUri,
+        });
+      }),
+    );
+    if (result instanceof Error) {
+      const failed = await this.finishSetup({
+        ...ctx,
+        setup,
+        status: "failed",
+        message:
+          result instanceof IntegrationSetupError
+            ? result.message
+            : "Connection setup failed. Restart setup to try again.",
+      });
+      if (failed instanceof Error) return failed;
+      return result;
+    }
+    if (result.status === "connected") {
+      const saved = await this.finishSetup({
+        ...ctx,
+        setup,
+        status: "ready",
+        connection: safeConnection(result.connection),
+      });
+      if (saved instanceof Error) return saved;
+      return {};
+    }
+    const safeAuthorization = await this.validateRemoteUrl(
+      result.authorizationUrl,
+    );
+    if (safeAuthorization instanceof Error) {
+      const cancelled = await this.withUser(ctx.userId, (executor) =>
+        executor.oauth.cancel(result.state),
+      );
+      if (cancelled instanceof Error) return cancelled;
+      const failed = await this.finishSetup({
+        ...ctx,
+        setup,
+        status: "failed",
+        message: "The provider returned an unsafe authorization URL.",
+      });
+      if (failed instanceof Error) return failed;
+      return safeAuthorization;
+    }
+    const saved = await this.sql(
+      "UPDATE halo_integration_setup SET oauth_state=$1 WHERE setup_id=$2 AND user_id=$3 AND status='authorizing' RETURNING *",
+      [result.state, ctx.setupId, ctx.userId],
+    );
+    if (saved instanceof Error) return saved;
+    return { authorizationUrl: result.authorizationUrl };
+  }
+
+  private async finishSetup(ctx: {
+    userId: string;
+    setupId: string;
+    setup: IntegrationSetup;
+    status: IntegrationSetup["status"];
+    connection?: IntegrationConnection;
+    message?: string;
+  }) {
+    const saved = await this.sql(
+      "UPDATE halo_integration_setup SET status=$1,data=$2,oauth_state=NULL WHERE setup_id=$3 AND user_id=$4 AND status='authorizing' RETURNING *",
+      [
+        ctx.status,
+        JSON.stringify({
+          ...ctx.setup,
+          status: ctx.status,
+          connection: ctx.connection,
+          message: ctx.message,
+        }),
+        ctx.setupId,
+        ctx.userId,
+      ],
+    );
+    if (saved instanceof Error) return saved;
+  }
+
+  async cancelSetup(ctx: { userId: string; setupId: string }) {
+    const setup = await this.setup(ctx);
+    if (setup instanceof Error) return setup;
+    // Claim cancellation before calling the SDK; a racing callback cannot consume the state.
+    const rows = await this.sql(
+      "UPDATE halo_integration_setup SET status='cancelled' WHERE setup_id=$1 AND user_id=$2 AND status IN ('awaiting_credentials','authorizing') AND (oauth_state IS NULL OR oauth_state NOT IN ('submitting','consuming')) RETURNING *",
+      [ctx.setupId, ctx.userId],
+    );
+    if (rows instanceof Error) return rows;
+    if (rows.length === 0 && setup.status === "authorizing")
+      return new IntegrationSetupError({
+        detail:
+          "Credential submission or authorization completion is in progress",
+      });
+    const state = rows[0]?.oauth_state;
+    if (state)
+      return await this.withUser(ctx.userId, (executor) =>
+        executor.oauth.cancel(OAuthState.make(state)),
+      );
+  }
+
+  async oauthCallback(ctx: { state: string; code?: string }) {
+    // Atomic durable claim provides single consumption even with multiple control-plane replicas.
+    const rows = await this.sql(
+      "UPDATE halo_integration_setup SET oauth_state='consuming' WHERE oauth_state=$1 AND oauth_state NOT IN ('submitting','consuming') AND status='authorizing' AND expires_at > $2 RETURNING *",
+      [ctx.state, Date.now()],
+    );
+    if (rows instanceof Error) return rows;
+    const row = rows[0];
+    if (row === undefined)
+      return new IntegrationSetupError({
+        detail: "Invalid or already consumed OAuth state",
+      });
+    const setup = await this.setup({
+      userId: row.user_id,
+      setupId: row.setup_id,
+    });
+    if (setup instanceof Error) return setup;
+    if (setup.status !== "authorizing")
+      return new IntegrationSetupError({
+        detail: "Authorization setup has expired",
+      });
+    const connection = await this.withUser(row.user_id, (executor) =>
+      Effect.gen(function* () {
+        if (ctx.code === undefined) {
+          yield* executor.oauth.cancel(OAuthState.make(ctx.state));
+          return new IntegrationSetupError({
+            detail: "Authorization was declined",
+          });
+        }
+        return yield* executor.oauth.complete({
+          state: OAuthState.make(ctx.state),
+          code: ctx.code,
+        });
+      }),
+    );
+    const saved = await this.finishSetup({
+      userId: row.user_id,
+      setupId: row.setup_id,
+      setup,
+      status: connection instanceof Error ? "failed" : "ready",
+      connection:
+        connection instanceof Error ? undefined : safeConnection(connection),
+      message:
+        connection instanceof Error
+          ? "Authorization failed. Restart setup to try again."
+          : undefined,
+    });
+    if (saved instanceof Error) return saved;
+    return { setupUrl: this.setupUrl(row.setup_id) };
+  }
+
+  async registerOpenAPI(ctx: {
+    userId: string;
+    name: string;
+    slug: string;
+    url: string;
+  }) {
+    const safe = await this.validateRemoteUrl(ctx.url);
+    if (safe instanceof Error) return safe;
+    return await this.withUser(ctx.userId, (executor) =>
+      Effect.asVoid(
+        executor.openapi.addSpec({
+          name: ctx.name,
+          slug: ctx.slug,
+          spec: { kind: "url", url: ctx.url },
+        }),
+      ),
+    );
+  }
+
+  async registerMcp(ctx: {
+    userId: string;
+    name: string;
+    slug: string;
+    endpoint: string;
+    auth: "none" | "bearer" | "oauth";
+  }) {
+    const safe = await this.validateRemoteUrl(ctx.endpoint);
+    if (safe instanceof Error) return safe;
+    return await this.withUser(ctx.userId, (executor) =>
+      Effect.asVoid(
+        executor.mcp.addServer({
+          name: ctx.name,
+          slug: ctx.slug,
+          endpoint: ctx.endpoint,
+          authenticationTemplate:
+            ctx.auth === "oauth"
+              ? [{ slug: "oauth2", kind: "oauth2" }]
+              : ctx.auth === "none"
+                ? [{ slug: "none", kind: "none" }]
+                : [
+                    {
+                      slug: "bearer",
+                      type: "apiKey",
+                      headers: {
+                        Authorization: [
+                          "Bearer ",
+                          { type: "variable", name: "token" },
+                        ],
+                      },
+                    },
+                  ],
+        }),
+      ),
+    );
+  }
+
+  private async validateRemoteUrl(value: string) {
+    const url = errore.try({
+      try: () => new URL(value),
+      catch: (cause) =>
+        new IntegrationSetupError({ detail: "Invalid remote URL", cause }),
+    });
+    if (url instanceof Error) return url;
+    if (
+      !["https:", "http:"].includes(url.protocol) ||
+      url.username ||
+      url.password ||
+      url.hash
+    )
+      return new IntegrationSetupError({ detail: "Unsafe remote URL" });
+    if (this.allowLocalUrls) return;
+    if (url.protocol !== "https:")
+      return new IntegrationSetupError({
+        detail: "Remote integrations require HTTPS",
+      });
+    const addresses = await dns
+      .lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true })
+      .catch(
+        (cause) =>
+          new IntegrationSetupError({
+            detail: "Remote host could not be resolved",
+            cause,
+          }),
+      );
+    if (addresses instanceof Error) return addresses;
+    if (
+      addresses.length === 0 ||
+      addresses.some(({ address }) => !publicAddress(address))
+    )
+      return new IntegrationSetupError({
+        detail: "Remote URL must resolve to a public network",
+      });
+  }
+
+  private safeFetch: typeof globalThis.fetch = async (input, init) => {
+    const request = new Request(input, init);
+    const safe = await this.validateRemoteUrl(request.url);
+    if (safe instanceof Error) throw safe;
+    const body =
+      request.body === null
+        ? undefined
+        : Buffer.from(await request.arrayBuffer());
+    // Check the addresses returned to the actual socket, not just an earlier
+    // DNS preflight. Keep the original hostname for Host and TLS verification.
+    return await new Promise<Response>((resolve, reject) => {
+      const transport = request.url.startsWith("https:") ? https : http;
+      const outgoing = transport.request(
+        request.url,
+        {
+          method: request.method,
+          headers: Object.fromEntries(request.headers),
+          signal: request.signal,
+          lookup: (hostname, options, callback) => {
+            void dns
+              .lookup(hostname, { all: true, family: options.family })
+              .then((addresses) => {
+                if (
+                  addresses.length === 0 ||
+                  (!this.allowLocalUrls &&
+                    addresses.some(({ address }) => !publicAddress(address)))
+                ) {
+                  callback(
+                    new IntegrationSetupError({
+                      detail: "Remote URL must resolve to a public network",
+                    }),
+                    "",
+                    4,
+                  );
+                  return;
+                }
+                callback(
+                  // oxlint-disable-next-line unicorn/no-null -- Node's DNS callback requires null for success.
+                  null,
+                  options.all ? addresses : addresses[0]!.address,
+                  addresses[0]!.family,
+                );
+              })
+              .catch((cause) =>
+                callback(
+                  new IntegrationSetupError({
+                    detail: "Remote host could not be resolved",
+                    cause,
+                  }),
+                  "",
+                  4,
+                ),
+              );
+          },
+        },
+        (incoming) => {
+          const status = incoming.statusCode ?? 500;
+          if (status >= 300 && status < 400) {
+            incoming.destroy();
+            reject(
+              new IntegrationSetupError({
+                detail: "Remote redirects are not allowed",
+              }),
+            );
+            return;
+          }
+          const headers = new Headers();
+          for (const [key, value] of Object.entries(incoming.headers)) {
+            if (value === undefined) continue;
+            for (const item of Array.isArray(value) ? value : [value])
+              headers.append(key, item);
+          }
+          const encoding = headers.get("content-encoding");
+          const decoder =
+            encoding === "gzip"
+              ? zlib.createGunzip()
+              : encoding === "deflate"
+                ? zlib.createInflate()
+                : encoding === "br"
+                  ? zlib.createBrotliDecompress()
+                  : undefined;
+          if (decoder !== undefined) {
+            headers.delete("content-encoding");
+            headers.delete("content-length");
+            incoming.once("error", (error) => decoder.destroy(error));
+            decoder.once("close", () => incoming.destroy());
+          }
+          const readable =
+            decoder === undefined ? incoming : incoming.pipe(decoder);
+          // SAFETY: Node's IncomingMessage and zlib transforms produce byte streams.
+          const responseBody =
+            request.method === "HEAD" || [204, 205, 304].includes(status)
+              ? undefined
+              : (stream.Readable.toWeb(readable) as ReadableStream<Uint8Array>);
+          if (responseBody === undefined) readable.resume();
+          const response = errore.try({
+            try: () => new Response(responseBody, { status, headers }),
+            catch: (cause) =>
+              new IntegrationServiceError({
+                detail: "read remote response",
+                cause,
+              }),
+          });
+          if (response instanceof Error) {
+            incoming.destroy();
+            reject(response);
+            return;
+          }
+          resolve(response);
+        },
+      );
+      outgoing.once("error", reject);
+      outgoing.end(body);
     });
+  };
+
+  private safeHttpLayer() {
+    return FetchHttpClient.layer.pipe(
+      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, this.safeFetch)),
+    );
   }
 
-  // Internal boundary only. Phase 2 derives userId from authenticated runtime
-  // state and exposes narrow operations; callers must not retain the executor.
+  async connections(userId: string) {
+    return await this.withUser(userId, (executor) =>
+      Effect.gen(function* () {
+        const connections = yield* executor.connections.list({
+          owner: Owner.make("user"),
+        });
+        return connections.map((connection): IntegrationConnection => ({
+          address: connection.address,
+          integration: connection.integration,
+          name: connection.name,
+          accountLabel: connection.identityLabel ?? undefined,
+        }));
+      }),
+    );
+  }
+
+  async search(ctx: {
+    userId: string;
+    query: string;
+    integration?: string;
+    limit?: number;
+    signal?: AbortSignal;
+  }) {
+    return await this.withUser(
+      ctx.userId,
+      (executor) =>
+        Effect.gen(function* () {
+          const tools = (yield* executor.tools.list({
+            query: ctx.query,
+            integration:
+              ctx.integration === undefined
+                ? undefined
+                : IntegrationSlug.make(ctx.integration),
+          })).filter(isIntegrationTool);
+          const limit = ctx.limit ?? 50;
+          return {
+            tools: tools.slice(0, limit).map(summarizeTool),
+            truncated: tools.length > limit,
+          };
+        }),
+      ctx.signal,
+    );
+  }
+
+  async describe(ctx: {
+    userId: string;
+    address: string;
+    signal?: AbortSignal;
+  }) {
+    return await this.withUser(
+      ctx.userId,
+      (executor) =>
+        Effect.gen(function* () {
+          const tool = yield* resolveTool(executor, ctx.address);
+          if (tool instanceof Error) return tool;
+          const schema = yield* executor.tools.schema(tool.address);
+          if (schema === null) return new IntegrationToolNotFoundError();
+          const json = serializeJson(schema);
+          if (json instanceof Error) return json;
+          // SAFETY: Serialization preserves the SDK schema object's keys and checks JSON compatibility.
+          const wire = json as {
+            inputSchema?: IntegrationJson;
+            outputSchema?: IntegrationJson;
+            schemaDefinitions?: IntegrationJson;
+          };
+          return {
+            ...summarizeTool(tool),
+            inputSchema: wire.inputSchema,
+            outputSchema: wire.outputSchema,
+            schemaDefinitions: wire.schemaDefinitions,
+            requiresApproval: tool.annotations?.requiresApproval,
+          } satisfies IntegrationToolSchema;
+        }),
+      ctx.signal,
+    );
+  }
+
+  async invoke(ctx: {
+    userId: string;
+    address: string;
+    arguments: Record<string, IntegrationJson>;
+    signal?: AbortSignal;
+  }) {
+    const result = await this.withUser(
+      ctx.userId,
+      (executor) =>
+        Effect.gen(function* () {
+          const tool = yield* resolveTool(executor, ctx.address);
+          if (tool instanceof Error) return tool;
+          return yield* executor.execute(tool.address, ctx.arguments).pipe(
+            Effect.match({
+              onFailure: (error): IntegrationInvocation => {
+                if (error instanceof ToolBlockedError)
+                  return { status: "blocked" };
+                if (error instanceof ElicitationDeclinedError)
+                  return { status: "approval_required" };
+                if (
+                  error instanceof CredentialResolutionError ||
+                  error instanceof CredentialProviderNotRegisteredError ||
+                  error instanceof ConnectionNotFoundError
+                )
+                  return { status: "connection_required" };
+                return {
+                  status: "failed",
+                  code: "outcome_unknown",
+                  message:
+                    "Integration invocation failed; do not automatically retry.",
+                };
+              },
+              onSuccess: (value): IntegrationInvocation => {
+                if (isToolResult(value) && !value.ok) {
+                  if (
+                    value.error.code === "connection_rejected" ||
+                    value.error.code === "oauth_scope_insufficient"
+                  )
+                    return { status: "connection_required" };
+                  const timeout =
+                    value.error.code === "upstream_response_headers_timeout" ||
+                    value.error.code === "upstream_response_body_timeout";
+                  return {
+                    status: "failed",
+                    code: timeout ? "outcome_unknown" : "tool_failed",
+                    message: timeout
+                      ? "Integration response timed out; do not automatically retry."
+                      : "The integration reported a tool error.",
+                  };
+                }
+                const json = serializeJson(
+                  isToolResult(value) && value.ok ? value.data : value,
+                );
+                if (json instanceof Error)
+                  return {
+                    status: "failed",
+                    code: "outcome_unknown",
+                    message:
+                      "Integration returned an unsupported result; do not automatically retry.",
+                  };
+                return { status: "completed", result: json };
+              },
+            }),
+          );
+        }),
+      ctx.signal,
+    );
+    if (result instanceof IntegrationToolNotFoundError) return result;
+    if (result instanceof Error)
+      return {
+        status: "failed",
+        code: "outcome_unknown",
+        message:
+          "Integration invocation interrupted or unavailable; do not automatically retry.",
+      } satisfies IntegrationInvocation;
+    return result;
+  }
+
+  // Internal boundary only. RPC callers derive userId from runtime authentication.
+  // Callbacks must not retain the executor.
   async withUser<A, E>(
     userId: string,
     run: (executor: IntegrationExecutor) => Effect.Effect<A, E>,
+    signal?: AbortSignal,
   ) {
     if (this.closed)
       return new IntegrationServiceError({ detail: "service is closed" });
-    const work = this.run(userId, run);
+    this.activeUsers.set(userId, (this.activeUsers.get(userId) ?? 0) + 1);
+    const work = this.run(userId, run, signal);
     this.active.add(work);
     await using cleanup = new errore.AsyncDisposableStack();
     cleanup.defer(() => {
       this.active.delete(work);
+      const count = this.activeUsers.get(userId)! - 1;
+      if (count === 0) this.activeUsers.delete(userId);
+      else this.activeUsers.set(userId, count);
     });
     return await work;
   }
@@ -127,18 +955,57 @@ export class IntegrationService {
   private async run<A, E>(
     userId: string,
     run: (executor: IntegrationExecutor) => Effect.Effect<A, E>,
+    signal?: AbortSignal,
   ) {
     let pending = this.executors.get(userId);
     if (pending === undefined) {
-      pending = this.create(userId);
+      const evicted =
+        this.executors.size >= 100
+          ? [...this.executors.keys()].find(
+              (id) => !this.activeUsers.has(id) && !this.initializing.has(id),
+            )
+          : undefined;
+      if (this.executors.size >= 100 && evicted === undefined)
+        return new IntegrationServiceError({
+          detail: "all Executor slots are busy",
+        });
+      const previous =
+        evicted === undefined ? undefined : this.executors.get(evicted);
+      if (evicted !== undefined) this.executors.delete(evicted);
+      this.initializing.add(userId);
+      pending = (async () => {
+        await using cleanup = new errore.AsyncDisposableStack();
+        cleanup.defer(() => {
+          this.initializing.delete(userId);
+        });
+        const old = await previous;
+        if (old !== undefined && !(old instanceof Error)) {
+          const closed = await Effect.runPromise(old.close()).catch(
+            (cause) =>
+              new IntegrationServiceError({ detail: "evict Executor", cause }),
+          );
+          if (closed instanceof Error) return closed;
+        }
+        return await this.create(userId);
+      })();
       this.executors.set(userId, pending);
     }
-    const executor = await pending;
-    if (executor instanceof Error) {
-      this.executors.delete(userId);
-      return executor;
-    }
-    return await Effect.runPromise(run(executor)).catch(
+    const initialization = pending;
+    const executors = this.executors;
+    return await Effect.runPromise(
+      Effect.gen(function* () {
+        const executor = yield* Effect.promise(
+          async () => await initialization,
+        );
+        if (executor instanceof Error) {
+          if (executors.get(userId) === initialization)
+            executors.delete(userId);
+          return executor;
+        }
+        return yield* run(executor);
+      }).pipe(Effect.timeout("30 seconds")),
+      { signal },
+    ).catch(
       (cause) =>
         new IntegrationServiceError({ detail: "execute operation", cause }),
     );
@@ -150,10 +1017,13 @@ export class IntegrationService {
         tenant: Tenant.make(userId),
         subject: Subject.make(userId),
         db: this.database,
+        fetch: this.safeFetch,
+        httpClientLayer: this.safeHttpLayer(),
+        firstPartyOAuthClients: this.firstPartyOAuthClients,
         providers: [this.credentialProvider(userId)],
         plugins: this.plugins,
         onElicitation: () => Effect.succeed({ action: "decline" as const }),
-      }),
+      }).pipe(Effect.timeout("30 seconds")),
     ).catch(
       (cause) =>
         new IntegrationServiceError({ detail: "create Executor", cause }),
@@ -167,6 +1037,33 @@ export class IntegrationService {
       );
       if (result instanceof Error) console.error(result);
     });
+    // Native fallback covers existing and future connections. Explicit restrictions still win.
+    const approved = await Effect.runPromise(
+      Effect.gen(function* () {
+        const policies = yield* executor.policies.list();
+        if (
+          policies.some(
+            (policy) =>
+              policy.owner === "org" &&
+              policy.pattern === "*" &&
+              policy.action === "approve",
+          )
+        )
+          return;
+        yield* executor.policies.create({
+          owner: Owner.make("org"),
+          pattern: "*",
+          action: "approve",
+        });
+      }).pipe(Effect.timeout("30 seconds")),
+    ).catch(
+      (cause) =>
+        new IntegrationServiceError({
+          detail: "configure default approval",
+          cause,
+        }),
+    );
+    if (approved instanceof Error) return approved;
     for (const preset of presets) {
       const { defaultSlug, url, specFormat } = preset;
       if (
@@ -195,7 +1092,7 @@ export class IntegrationService {
             ),
             healthCheck: preset.healthCheck,
           });
-        }),
+        }).pipe(Effect.timeout("30 seconds")),
       ).catch(
         (cause) =>
           new IntegrationServiceError({
@@ -262,6 +1159,106 @@ export class IntegrationService {
   }
 }
 
+function setupCatalogEntry(
+  integration: Integration,
+): IntegrationSetupCatalogEntry {
+  return {
+    integration: integration.slug,
+    name: integration.name,
+    methods: integration.authMethods.map((method) => ({
+      template: method.template,
+      label: method.label,
+      kind: method.kind,
+      fields:
+        method.kind === "oauth" || method.kind === "none"
+          ? []
+          : [
+              ...new Set(
+                (method.placements ?? [])
+                  .filter((placement) => placement.literal === undefined)
+                  .map((placement) => placement.variable ?? "token"),
+              ),
+            ],
+    })),
+  };
+}
+
+function safeConnection(connection: Connection): IntegrationConnection {
+  return {
+    address: connection.address,
+    integration: connection.integration,
+    name: connection.name,
+    accountLabel: connection.identityLabel ?? undefined,
+  };
+}
+
+function publicAddress(address: string) {
+  if (address.includes(":"))
+    return (
+      /^[23][0-9a-f]{3}:/i.test(address) &&
+      !/^(2001:(db8|0):|2002:|3fff:)/i.test(address)
+    );
+  const [a, b] = address.split(".").map(Number);
+  return (
+    a !== undefined &&
+    b !== undefined &&
+    a > 0 &&
+    a < 224 &&
+    a !== 10 &&
+    a !== 127 &&
+    !(a === 169 && b === 254) &&
+    !(a === 172 && b >= 16 && b <= 31) &&
+    !(a === 192 && (b === 168 || b === 0 || b === 2 || b === 88)) &&
+    !(a === 100 && b >= 64 && b <= 127) &&
+    !(a === 198 && (b === 18 || b === 19 || b === 51)) &&
+    !(a === 203 && b === 0)
+  );
+}
+
+function isIntegrationTool(tool: Tool) {
+  return (
+    tool.static !== true &&
+    (tool.pluginId === "openapi" || tool.pluginId === "mcp") &&
+    parseToolAddress(tool.address) !== null
+  );
+}
+
+function summarizeTool(tool: Tool): IntegrationTool {
+  return {
+    address: tool.address,
+    integration: tool.integration,
+    connection: tool.connection,
+    name: tool.name,
+    description: tool.description,
+  };
+}
+
+function resolveTool(executor: IntegrationExecutor, address: string) {
+  return Effect.gen(function* () {
+    if (parseToolAddress(address) === null)
+      return new IntegrationToolNotFoundError();
+    const tools = yield* executor.tools.list({ includeBlocked: true });
+    return (
+      tools.find(
+        (tool) => tool.address === address && isIntegrationTool(tool),
+      ) ?? new IntegrationToolNotFoundError()
+    );
+  });
+}
+
+// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Executor returns unknown; this is the SDK-to-JSON boundary.
+function serializeJson(value: unknown) {
+  return errore.try({
+    // SAFETY: A successful JSON serialization and parse produces only JSON values.
+    try: () => JSON.parse(JSON.stringify(value)) as IntegrationJson,
+    catch: (cause) =>
+      new IntegrationServiceError({
+        detail: "serialize integration result",
+        cause,
+      }),
+  });
+}
+
 function toEffect<A>(
   label: string,
   run: () => Promise<A | Error>,

```

```source-diff:current-tests:apps/control-plane/test/ControlPlane.test.ts
diff --git a/apps/control-plane/test/ControlPlane.test.ts b/apps/control-plane/test/ControlPlane.test.ts
index 2dfafcf..c175aa8 100644
--- a/apps/control-plane/test/ControlPlane.test.ts
+++ b/apps/control-plane/test/ControlPlane.test.ts
@@ -1,9 +1,17 @@
 import { gzipSync } from "node:zlib";
+import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
+import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
+import {
+  CallToolRequestSchema,
+  ListToolsRequestSchema,
+} from "@modelcontextprotocol/sdk/types.js";
+import { Type } from "@sinclair/typebox";
 import {
   AuthTemplateSlug,
   ConnectionName,
   Effect,
   IntegrationSlug,
+  OAuthClientSlug,
   Owner,
   ToolAddress,
 } from "@executor-js/sdk/core";
@@ -24,7 +32,7 @@ import {
 import { betterAuth } from "better-auth";
 import { testUtils } from "better-auth/plugins";
 import * as errore from "errore";
-import { expect, test } from "vitest";
+import { expect, test, vi } from "vitest";
 import { ControlPlane } from "../src/server/ControlPlane.js";
 import { LocalWorkspaceProvider } from "../src/workspace/provider/local/LocalWorkspaceProvider.js";
 import type { WorkspaceProviderApi } from "../src/workspace/provider/WorkspaceProviderApi.js";
@@ -105,14 +113,17 @@ const desktopAuthState = "desktop-auth-state-0123456789abcdef";
 const integrationEncryptionKey = Buffer.alloc(32, 17);
 // Only Google's external Discovery HTTP boundary is replaced. Executor parses,
 // installs and persists the document through its real OpenAPI plugin.
-const getOpenAPISpec = async (_url: string) =>
+const getOpenAPISpec = async (
+  _url: string,
+  origin = "https://example.invalid",
+) =>
   JSON.stringify({
     discoveryVersion: "v1",
     id: "test:v1",
     name: "test",
     version: "v1",
     title: "Test Google API",
-    rootUrl: "https://example.invalid/",
+    rootUrl: `${origin}/`,
     servicePath: "test/v1/",
     resources: {
       documents: {
@@ -123,6 +134,12 @@ const getOpenAPISpec = async (_url: string) =>
             httpMethod: "GET",
             response: { type: "object" },
           },
+          create: {
+            id: "test.documents.create",
+            path: "documents",
+            httpMethod: "POST",
+            response: { type: "object" },
+          },
         },
       },
     },
@@ -139,22 +156,198 @@ const controlPlaneTest = test.extend<{
   webRoot: string;
   workspaceProvider: WorkspaceProviderApi;
   workspaceHost: WorkspaceHostDriver;
+  allowLocalIntegrationUrls: boolean;
+  mcpApi: { publicEndpoint: string; privateEndpoint: string; calls: string[] };
   integrationApi: {
     origin: string;
     requests: { url: string | undefined; authorization: string | undefined }[];
+    disconnected: string[];
   };
 }>({
+  allowLocalIntegrationUrls: true,
+  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
+  mcpApi: async ({}, use) => {
+    const calls: string[] = [];
+    const inputSchema = Type.Object({ marker: Type.String() });
+    const server = http.createServer(async (request, response) => {
+      if (request.url !== "/public" && request.url !== "/private") {
+        response.writeHead(404).end();
+        return;
+      }
+      if (
+        request.url === "/private" &&
+        request.headers.authorization !== "Bearer fixture-mcp-key"
+      ) {
+        response.writeHead(401).end();
+        return;
+      }
+      await using cleanup = new errore.AsyncDisposableStack();
+      const mcp = new McpServer(
+        { name: "fixture", version: "1" },
+        { capabilities: { tools: {} } },
+      );
+      cleanup.defer(async () => await mcp.close());
+      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
+        tools: [
+          { name: "echo_marker", description: "Echo a marker", inputSchema },
+          {
+            name: "write_marker",
+            description: "Write a marker",
+            inputSchema,
+            annotations: { destructiveHint: true },
+          },
+        ],
+      }));
+      mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
+        if (
+          !["echo_marker", "write_marker"].includes(params.name) ||
+          !Value.Check(inputSchema, params.arguments)
+        )
+          return {
+            isError: true,
+            content: [{ type: "text", text: "Invalid echo input" }],
+          };
+        calls.push(params.arguments.marker);
+        return {
+          content: [
+            { type: "text", text: `MCP received: ${params.arguments.marker}` },
+          ],
+        };
+      });
+      const transport = new StreamableHTTPServerTransport({
+        sessionIdGenerator: undefined,
+        enableJsonResponse: true,
+      });
+      await mcp.connect(transport);
+      await transport.handleRequest(request, response);
+    });
+    server.listen(0, "127.0.0.1");
+    await events.once(server, "listening");
+    await using cleanup = new errore.AsyncDisposableStack();
+    cleanup.defer(async () => {
+      server.closeAllConnections();
+      await new Promise<void>((resolveClose, reject) =>
+        server.close((error) =>
+          error === undefined ? resolveClose() : reject(error),
+        ),
+      );
+    });
+    // SAFETY: A listening TCP server returns AddressInfo.
+    const address = server.address() as AddressInfo;
+    const origin = `http://127.0.0.1:${address.port}`;
+    await use({
+      publicEndpoint: `${origin}/public`,
+      privateEndpoint: `${origin}/private`,
+      calls,
+    });
+  },
   // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
   integrationApi: async ({}, use) => {
     const requests: {
       url: string | undefined;
       authorization: string | undefined;
     }[] = [];
+    const disconnected: string[] = [];
     const server = http.createServer((request, response) => {
       requests.push({
         url: request.url,
         authorization: request.headers.authorization,
       });
+      if (request.url === "/redirect-spec") {
+        response
+          .writeHead(302, {
+            location: "http://169.254.169.254/computeMetadata/v1/",
+          })
+          .end();
+        return;
+      }
+      if (request.url === "/setup-spec" || request.url === "/key-spec") {
+        const origin = `http://${request.headers.host}`;
+        response.writeHead(200, { "content-type": "application/json" }).end(
+          JSON.stringify({
+            openapi: "3.0.0",
+            info: { title: "Setup fixture", version: "1" },
+            servers: [{ url: origin }],
+            components: {
+              securitySchemes:
+                request.url === "/key-spec"
+                  ? {
+                      key: {
+                        type: "apiKey",
+                        in: "header",
+                        name: "X-Api-Key",
+                      },
+                    }
+                  : {
+                      oauth: {
+                        type: "oauth2",
+                        flows: {
+                          authorizationCode: {
+                            authorizationUrl: `${origin}/oauth/authorize`,
+                            tokenUrl: `${origin}/oauth/token`,
+                            scopes: { read: "Read" },
+                          },
+                        },
+                      },
+                    },
+            },
+            security:
+              request.url === "/key-spec"
+                ? [{ key: [] }]
+                : [{ oauth: ["read"] }],
+            paths: {
+              "/items": {
+                get: {
+                  operationId: "listItems",
+                  responses: { "200": { description: "OK" } },
+                },
+              },
+            },
+          }),
+        );
+        return;
+      }
+      if (request.url === "/oauth/token") {
+        response.writeHead(200, { "content-type": "application/json" }).end(
+          JSON.stringify({
+            access_token: "fixture-google-token",
+            token_type: "Bearer",
+            expires_in: 3600,
+            refresh_token: "fixture-refresh-token",
+          }),
+        );
+        return;
+      }
+      if (request.url === "/test/v1/documents") {
+        if (request.headers.authorization !== "Bearer fixture-google-token") {
+          response.writeHead(401).end();
+          return;
+        }
+        response
+          .writeHead(200, { "content-type": "application/json" })
+          .end(JSON.stringify({ items: ["google-document"] }));
+        return;
+      }
+      if (request.url === "/lost") {
+        request.socket.destroy();
+        return;
+      }
+      if (request.url === "/slow") {
+        response.once("close", () => disconnected.push("/slow"));
+        return;
+      }
+      if (request.url === "/error") {
+        response
+          .writeHead(500, { "content-type": "application/json" })
+          .end(JSON.stringify({ error: "provider failed" }));
+        return;
+      }
+      if (request.url?.startsWith("/mutations/")) {
+        response
+          .writeHead(200, { "content-type": "application/json" })
+          .end(JSON.stringify({ written: request.url.split("/").at(-1) }));
+        return;
+      }
       if (request.url !== "/items") {
         response.writeHead(404).end();
         return;
@@ -176,7 +369,11 @@ const controlPlaneTest = test.extend<{
     });
     // SAFETY: A listening TCP server has AddressInfo, not a pipe address.
     const address = server.address() as AddressInfo;
-    await use({ origin: `http://127.0.0.1:${address.port}`, requests });
+    await use({
+      origin: `http://127.0.0.1:${address.port}`,
+      requests,
+      disconnected,
+    });
   },
   // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
   inferenceApiKey: async ({}, use) => {
@@ -216,7 +413,15 @@ const controlPlaneTest = test.extend<{
     await use(webRoot);
   },
   plane: async (
-    { appDataDir, webRoot, traceCloud, workspaceProvider, inferenceApiKey },
+    {
+      appDataDir,
+      webRoot,
+      traceCloud,
+      workspaceProvider,
+      inferenceApiKey,
+      integrationApi,
+      allowLocalIntegrationUrls,
+    },
     use,
   ) => {
     const plane = await ControlPlane.start({
@@ -233,7 +438,9 @@ const controlPlaneTest = test.extend<{
       traceCloud: traceCloud.cloud(),
       inferenceApiKey,
       integrationEncryptionKey,
-      getOpenAPISpec,
+      allowLocalIntegrationUrls,
+      getOpenAPISpec: async (url) =>
+        await getOpenAPISpec(url, integrationApi.origin),
     });
     if (plane instanceof Error) throw plane;
     await use(plane);
@@ -268,6 +475,1159 @@ const controlPlaneTest = test.extend<{
   },
 });
 
+controlPlaneTest(
+  "creates human-only connections through durable setup RPC",
+  async ({ plane, authenticatedRpc, browserHeaders, appDataDir, mcpApi }) => {
+    const human = authenticatedRpc;
+    await human.workspace.ensure();
+    const runtime = createControlPlaneRpcClient(
+      plane.origin,
+      (await readRuntimeSettings(appDataDir)).token,
+    );
+    await human.integrations.registerMcp({
+      name: "Public MCP",
+      slug: "setup-public",
+      endpoint: mcpApi.publicEndpoint,
+      auth: "none",
+    });
+    await human.integrations.registerMcp({
+      name: "Private MCP",
+      slug: "setup-private",
+      endpoint: mcpApi.privateEndpoint,
+      auth: "bearer",
+    });
+    const catalog = await runtime.integrations.catalog();
+    expect(
+      catalog.find((entry) => entry.integration === "setup-private")?.methods,
+    ).toEqual([
+      {
+        template: "bearer",
+        label: expect.any(String),
+        kind: "apikey",
+        fields: ["token"],
+      },
+    ]);
+    const bobHeaders = await createAuthenticatedHeaders(
+      appDataDir,
+      plane.origin,
+      "setup-bob@example.com",
+    );
+    bobHeaders.set("origin", plane.origin);
+    const bob = createControlPlaneRpcClient(plane.origin, bobHeaders);
+    for (const integration of ["setup-public", "setup-private"]) {
+      const started = await runtime.integrations.startSetup({
+        integration,
+        connectionName: "personal",
+      });
+      expect(started.setupUrl).toBe(
+        `${plane.origin}/integrations/setup/${started.setupId}`,
+      );
+      expect(
+        await human.integrations.setup({ setupId: started.setupId }),
+      ).toMatchObject({
+        status: "awaiting_credentials",
+      });
+      await expect(
+        bob.integrations.setup({ setupId: started.setupId }),
+      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
+      await expect(
+        bob.integrations.cancelSetup({ setupId: started.setupId }),
+      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
+      await expect(
+        bob.integrations.submitSetup({
+          setupId: started.setupId,
+          template: "none",
+        }),
+      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
+      await expect(
+        runtime.integrations.submitSetup({
+          setupId: started.setupId,
+          template: "none",
+        }),
+      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
+      await expect(
+        runtime.integrations.registerMcp({
+          name: "Bad",
+          slug: "bad",
+          endpoint: mcpApi.publicEndpoint,
+          auth: "none",
+        }),
+      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
+      const method = catalog.find((entry) => entry.integration === integration)!
+        .methods[0]!;
+      await human.integrations.submitSetup({
+        setupId: started.setupId,
+        template: method.template,
+        values: method.kind === "none" ? {} : { token: "fixture-mcp-key" },
+      });
+      const ready = await runtime.integrations.setup({
+        setupId: started.setupId,
+      });
+      expect(ready).toMatchObject({
+        status: "ready",
+        connection: { integration, name: "personal" },
+      });
+      expect(JSON.stringify(ready)).not.toContain("fixture-mcp-key");
+      await expect(
+        human.integrations.submitSetup({
+          setupId: started.setupId,
+          template: method.template,
+        }),
+      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
+      const duplicateName = await human.integrations.startSetup({
+        integration,
+        connectionName: "personal",
+      });
+      await expect(
+        human.integrations.submitSetup({
+          setupId: duplicateName.setupId,
+          template: method.template,
+          values: method.kind === "none" ? {} : { token: "do-not-overwrite" },
+        }),
+      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
+      await human.integrations.cancelSetup({ setupId: duplicateName.setupId });
+      const tools = await runtime.integrations.search({
+        query: "echo",
+        integration,
+      });
+      expect(
+        await runtime.integrations.invoke({
+          address: tools.tools[0]!.address,
+          arguments: { marker: integration },
+        }),
+      ).toMatchObject({ status: "completed" });
+    }
+    const cancelled = await human.integrations.startSetup({
+      integration: "setup-public",
+    });
+    await runtime.integrations.cancelSetup({ setupId: cancelled.setupId });
+    await runtime.integrations.cancelSetup({ setupId: cancelled.setupId });
+    expect(
+      await human.integrations.setup({ setupId: cancelled.setupId }),
+    ).toMatchObject({ status: "cancelled" });
+    const crossOrigin = new Headers(browserHeaders);
+    crossOrigin.set("origin", "https://untrusted.example");
+    await expect(
+      createControlPlaneRpcClient(
+        plane.origin,
+        crossOrigin,
+      ).integrations.submitSetup({
+        setupId: cancelled.setupId,
+        template: "none",
+      }),
+    ).rejects.toMatchObject({ code: "FORBIDDEN" });
+    const callback = await fetch(
+      `${plane.origin}/api/integrations/oauth/callback?state=foreign&code=secret`,
+      { redirect: "manual" },
+    );
+    expect(callback.status).toBe(400);
+    expect(await callback.text()).not.toContain("secret");
+  },
+);
+
+controlPlaneTest(
+  "redeems OAuth setup state once and preserves setups across restart",
+  async ({
+    plane,
+    authenticatedRpc,
+    browserHeaders,
+    appDataDir,
+    integrationApi,
+    webRoot,
+    workspaceProvider,
+  }) => {
+    await expect(
+      authenticatedRpc.integrations.registerOpenAPI({
+        name: "Redirect",
+        slug: "redirect",
+        url: `${integrationApi.origin}/redirect-spec`,
+      }),
+    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
+    await authenticatedRpc.integrations.registerOpenAPI({
+      name: "Local OAuth",
+      slug: "setup-oauth",
+      url: `${integrationApi.origin}/setup-spec`,
+    });
+    await authenticatedRpc.integrations.registerOpenAPI({
+      name: "Local key",
+      slug: "setup-key",
+      url: `${integrationApi.origin}/key-spec`,
+    });
+    const session = await authenticatedRpc.auth.session();
+    if (session.status !== "signed-in") throw new Error("Missing session");
+    const missingClient = await authenticatedRpc.integrations.startSetup({
+      integration: "setup-oauth",
+    });
+    const oauthMethod = (await authenticatedRpc.integrations.catalog()).find(
+      (entry) => entry.integration === "setup-oauth",
+    )!.methods[0]!;
+    await expect(
+      authenticatedRpc.integrations.submitSetup({
+        setupId: missingClient.setupId,
+        template: oauthMethod.template,
+      }),
+    ).rejects.toMatchObject({
+      code: "BAD_REQUEST",
+      message: expect.stringContaining("No configured OAuth client"),
+    });
+    expect(
+      await authenticatedRpc.integrations.setup({
+        setupId: missingClient.setupId,
+      }),
+    ).toMatchObject({ status: "failed" });
+    const configured = await plane.integrations!.withUser(
+      session.session.user.id,
+      (executor) =>
+        executor.oauth.createClient({
+          owner: Owner.make("user"),
+          slug: OAuthClientSlug.make("local"),
+          authorizationUrl: `${integrationApi.origin}/oauth/authorize`,
+          tokenUrl: `${integrationApi.origin}/oauth/token`,
+          grant: "authorization_code",
+          clientId: "fixture",
+          clientSecret: "private-client-secret",
+        }),
+    );
+    if (configured instanceof Error) throw configured;
+    const googleConfigured = await plane.integrations!.withUser(
+      session.session.user.id,
+      (executor) =>
+        executor.openapi.configure(IntegrationSlug.make("google_gmail"), {
+          authenticationTemplate: [
+            {
+              slug: "googleOAuth2",
+              kind: "oauth2",
+              authorizationUrl: `${integrationApi.origin}/oauth/authorize`,
+              tokenUrl: `${integrationApi.origin}/oauth/token`,
+              scopes: ["read"],
+            },
+          ],
+        }),
+    );
+    if (googleConfigured instanceof Error) throw googleConfigured;
+    const google = await authenticatedRpc.integrations.startSetup({
+      integration: "google_gmail",
+    });
+    const googleAuthorization = await authenticatedRpc.integrations.submitSetup(
+      { setupId: google.setupId, template: "googleOAuth2" },
+    );
+    const googleState = new URL(
+      googleAuthorization.authorizationUrl!,
+    ).searchParams.get("state")!;
+    expect(
+      (
+        await fetch(
+          `${plane.origin}/api/integrations/oauth/callback?state=${encodeURIComponent(googleState)}&code=google-code`,
+          { redirect: "manual" },
+        )
+      ).status,
+    ).toBe(303);
+    expect(
+      await authenticatedRpc.integrations.setup({ setupId: google.setupId }),
+    ).toMatchObject({
+      status: "ready",
+      connection: { integration: "google_gmail" },
+    });
+    const catalog = await authenticatedRpc.integrations.catalog();
+    const keyMethod = catalog.find(
+      (entry) => entry.integration === "setup-key",
+    )!.methods[0]!;
+    const key = await authenticatedRpc.integrations.startSetup({
+      integration: "setup-key",
+    });
+    await authenticatedRpc.integrations.submitSetup({
+      setupId: key.setupId,
+      template: keyMethod.template,
+      values: { token: "private-api-key" },
+    });
+    expect(
+      await authenticatedRpc.integrations.setup({ setupId: key.setupId }),
+    ).toMatchObject({ status: "ready" });
+    const method = catalog.find((entry) => entry.integration === "setup-oauth")!
+      .methods[0]!;
+    const start = await authenticatedRpc.integrations.startSetup({
+      integration: "setup-oauth",
+    });
+    const submitted = await authenticatedRpc.integrations.submitSetup({
+      setupId: start.setupId,
+      template: method.template,
+    });
+    const state = new URL(submitted.authorizationUrl!).searchParams.get(
+      "state",
+    )!;
+    expect(submitted.authorizationUrl).not.toContain("private-client-secret");
+    await plane.close();
+    const reopened = await ControlPlane.start({
+      config: {
+        deployment: "local",
+        workspace: { deployment: "local" },
+        appDataDir,
+        port: 0,
+        auth: testAuth,
+      },
+      webRoot,
+      workspaceProvider,
+      integrationEncryptionKey,
+      allowLocalIntegrationUrls: true,
+      getOpenAPISpec,
+    });
+    if (reopened instanceof Error) throw reopened;
+    await using cleanup = new errore.AsyncDisposableStack();
+    cleanup.defer(async () => {
+      const closed = await reopened.close();
+      if (closed instanceof Error) console.warn(closed);
+    });
+    const headers = new Headers(browserHeaders);
+    headers.set("origin", reopened.origin);
+    const human = createControlPlaneRpcClient(reopened.origin, headers);
+    expect(
+      await human.integrations.setup({ setupId: start.setupId }),
+    ).toMatchObject({ status: "authorizing" });
+    const callback = `${reopened.origin}/api/integrations/oauth/callback?state=${encodeURIComponent(state)}&code=fixture-code`;
+    const responses = await Promise.all([
+      fetch(callback, { redirect: "manual" }),
+      fetch(callback, { redirect: "manual" }),
+    ]);
+    expect(
+      responses.map((response) => response.status).toSorted((a, b) => a - b),
+    ).toEqual([303, 400]);
+    expect(
+      responses
+        .find((response) => response.status === 303)!
+        .headers.get("location"),
+    ).toBe(`${reopened.origin}/integrations/setup/${start.setupId}`);
+    const ready = await human.integrations.setup({ setupId: start.setupId });
+    expect(ready).toMatchObject({
+      status: "ready",
+      connection: { integration: "setup-oauth" },
+    });
+    expect(JSON.stringify(ready)).not.toContain("fixture-google-token");
+    expect(
+      await human.integrations.setup({ setupId: key.setupId }),
+    ).toMatchObject({ status: "ready" });
+    const cancelled = await human.integrations.startSetup({
+      integration: "setup-oauth",
+    });
+    const authorization = await human.integrations.submitSetup({
+      setupId: cancelled.setupId,
+      template: method.template,
+    });
+    await human.integrations.cancelSetup({ setupId: cancelled.setupId });
+    const cancelledState = new URL(
+      authorization.authorizationUrl!,
+    ).searchParams.get("state")!;
+    expect(
+      (
+        await fetch(
+          `${reopened.origin}/api/integrations/oauth/callback?state=${encodeURIComponent(cancelledState)}&code=fixture-code`,
+          { redirect: "manual" },
+        )
+      ).status,
+    ).toBe(400);
+    const declined = await human.integrations.startSetup({
+      integration: "setup-oauth",
+    });
+    const declinedAuthorization = await human.integrations.submitSetup({
+      setupId: declined.setupId,
+      template: method.template,
+    });
+    const declinedState = new URL(
+      declinedAuthorization.authorizationUrl!,
+    ).searchParams.get("state")!;
+    expect(
+      (
+        await fetch(
+          `${reopened.origin}/api/integrations/oauth/callback?state=${encodeURIComponent(declinedState)}&error=access_denied`,
+          { redirect: "manual" },
+        )
+      ).status,
+    ).toBe(303);
+    expect(
+      await human.integrations.setup({ setupId: declined.setupId }),
+    ).toMatchObject({ status: "failed" });
+    const expiring = await human.integrations.startSetup({
+      integration: "setup-oauth",
+    });
+    const expiringAuthorization = await human.integrations.submitSetup({
+      setupId: expiring.setupId,
+      template: method.template,
+    });
+    const pendingKey = await human.integrations.startSetup({
+      integration: "setup-key",
+    });
+    const expiringState = new URL(
+      expiringAuthorization.authorizationUrl!,
+    ).searchParams.get("state")!;
+    vi.useFakeTimers({ toFake: ["Date"] });
+    cleanup.defer(() => {
+      vi.useRealTimers();
+    });
+    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
+    expect(
+      await human.integrations.setup({ setupId: expiring.setupId }),
+    ).toMatchObject({ status: "expired" });
+    expect(
+      await human.integrations.setup({ setupId: pendingKey.setupId }),
+    ).toMatchObject({ status: "expired" });
+    expect(
+      (
+        await fetch(
+          `${reopened.origin}/api/integrations/oauth/callback?state=${encodeURIComponent(expiringState)}&code=fixture-code`,
+          { redirect: "manual" },
+        )
+      ).status,
+    ).toBe(400);
+    await expect(
+      human.integrations.submitSetup({
+        setupId: pendingKey.setupId,
+        template: keyMethod.template,
+        values: { token: "never-save" },
+      }),
+    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
+  },
+);
+
+controlPlaneTest.extend({ allowLocalIntegrationUrls: false })(
+  "rejects private and unsafe registration URLs",
+  async ({ authenticatedRpc, plane }) => {
+    for (const url of [
+      "https://127.0.0.1/spec",
+      "https://10.0.0.1/spec",
+      "https://169.254.169.254/computeMetadata/v1",
+      "https://[::1]/spec",
+      "https://[::ffff:127.0.0.1]/spec",
+      "http://example.com/spec",
+      "file:///etc/passwd",
+      "https://user:secret@example.com/spec",
+    ]) {
+      await expect(
+        authenticatedRpc.integrations.registerOpenAPI({
+          name: "Unsafe",
+          slug: "unsafe",
+          url,
+        }),
+      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
+      await expect(
+        authenticatedRpc.integrations.registerMcp({
+          name: "Unsafe",
+          slug: "unsafe",
+          endpoint: url,
+          auth: "none",
+        }),
+      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
+    }
+    const catalog = await authenticatedRpc.integrations.catalog();
+    expect(
+      catalog.find((entry) => entry.integration === "unsafe"),
+    ).toBeUndefined();
+    const google = await authenticatedRpc.integrations.startSetup({
+      integration: "google_gmail",
+    });
+    const authorization = await authenticatedRpc.integrations.submitSetup({
+      setupId: google.setupId,
+      template: "googleOAuth2",
+    });
+    expect(new URL(authorization.authorizationUrl!).hostname).toBe(
+      "accounts.google.com",
+    );
+    expect(
+      new URL(authorization.authorizationUrl!).searchParams.get("client_id"),
+    ).toBe(testAuth.googleClientId);
+    expect(authorization.authorizationUrl).not.toContain(
+      testAuth.googleClientSecret,
+    );
+    expect(
+      new URL(authorization.authorizationUrl!).searchParams.get("redirect_uri"),
+    ).toBe(`${plane.origin}/api/integrations/oauth/callback`);
+    await authenticatedRpc.integrations.cancelSetup({
+      setupId: google.setupId,
+    });
+  },
+);
+
+controlPlaneTest(
+  "automatically approves MCP, OpenAPI and Google connections across restart",
+  async ({
+    plane,
+    authenticatedRpc,
+    browserHeaders,
+    appDataDir,
+    mcpApi,
+    integrationApi,
+    webRoot,
+    workspaceProvider,
+  }) => {
+    await authenticatedRpc.workspace.ensure();
+    const client = createControlPlaneRpcClient(
+      plane.origin,
+      (await readRuntimeSettings(appDataDir)).token,
+    );
+    const session = await authenticatedRpc.auth.session();
+    if (session.status !== "signed-in") throw new Error("Missing test session");
+    const userId = session.session.user.id;
+    const setup = await plane.integrations!.withUser(userId, (executor) =>
+      Effect.gen(function* () {
+        yield* executor.mcp.addServer({
+          name: "MCP",
+          slug: "approval_mcp",
+          endpoint: mcpApi.publicEndpoint,
+          auth: { kind: "none" },
+        });
+        yield* executor.openapi.addSpec({
+          name: "OpenAPI",
+          slug: "approval_api",
+          spec: {
+            kind: "blob",
+            value: JSON.stringify({
+              openapi: "3.0.0",
+              info: { title: "Approval API", version: "1" },
+              servers: [{ url: integrationApi.origin }],
+              paths: {
+                "/items": {
+                  get: {
+                    operationId: "listItems",
+                    responses: { "200": { description: "OK" } },
+                  },
+                },
+                "/mutations/approved": {
+                  post: {
+                    operationId: "writeItem",
+                    responses: { "200": { description: "OK" } },
+                  },
+                },
+              },
+            }),
+          },
+        });
+        for (const integration of ["approval_mcp", "approval_api"]) {
+          for (const name of ["personal", "other"]) {
+            yield* executor.connections.create({
+              owner: Owner.make("user"),
+              integration: IntegrationSlug.make(integration),
+              name: ConnectionName.make(name),
+              template: AuthTemplateSlug.make("none"),
+              values: {},
+            });
+          }
+        }
+        const oauthClient = yield* executor.oauth.createClient({
+          owner: Owner.make("user"),
+          slug: OAuthClientSlug.make("google_fixture"),
+          authorizationUrl: `${integrationApi.origin}/oauth/authorize`,
+          tokenUrl: `${integrationApi.origin}/oauth/token`,
+          grant: "authorization_code",
+          clientId: "fixture",
+          clientSecret: "fixture-secret",
+        });
+        for (const name of ["personal", "other"]) {
+          const started = yield* executor.oauth.start({
+            client: oauthClient,
+            clientOwner: Owner.make("user"),
+            owner: Owner.make("user"),
+            name: ConnectionName.make(name),
+            integration: IntegrationSlug.make("google_gmail"),
+            template: AuthTemplateSlug.make("googleOAuth2"),
+            redirectUri: `${plane.origin}/integrations/oauth/callback`,
+          });
+          if (started.status !== "redirect")
+            throw new Error("Expected Google OAuth redirect");
+          expect(
+            new URL(started.authorizationUrl).searchParams.get(
+              "code_challenge",
+            ),
+          ).toBeTruthy();
+          yield* executor.oauth.complete({
+            state: started.state,
+            code: `fixture-code-${name}`,
+          });
+        }
+      }),
+    );
+    if (setup instanceof Error) throw setup;
+    const bobHeaders = await createAuthenticatedHeaders(
+      appDataDir,
+      plane.origin,
+      "approval-bob@example.com",
+    );
+    bobHeaders.set("origin", plane.origin);
+    const bob = createControlPlaneRpcClient(plane.origin, bobHeaders);
+    const csrfHeaders = new Headers(browserHeaders);
+    csrfHeaders.set("origin", "https://untrusted.example");
+    const csrf = createControlPlaneRpcClient(plane.origin, csrfHeaders);
+    expect(await bob.integrations.connections()).toEqual([]);
+    await expect(client.integrations.connections()).rejects.toMatchObject({
+      code: "UNAUTHORIZED",
+    });
+    await expect(csrf.integrations.connections()).rejects.toMatchObject({
+      code: "FORBIDDEN",
+    });
+    for (const integration of [
+      "approval_mcp",
+      "approval_api",
+      "google_gmail",
+    ]) {
+      const connection = (
+        await authenticatedRpc.integrations.connections()
+      ).find(
+        (entry) =>
+          entry.integration === integration && entry.name === "personal",
+      )!;
+      expect(connection).toBeDefined();
+      const tools = (
+        await client.integrations.search({ query: "", integration })
+      ).tools.filter((tool) => tool.connection === "personal");
+      const described = await Promise.all(
+        tools.map(
+          async (tool) =>
+            await client.integrations.describe({ address: tool.address }),
+        ),
+      );
+      const read = described.find((tool) => !tool.requiresApproval)!;
+      const write = described.find((tool) => tool.requiresApproval)!;
+      expect(read).toBeDefined();
+      expect(write).toBeDefined();
+      const args = integration === "approval_mcp" ? { marker: "allowed" } : {};
+      const invokeWrite = async () =>
+        await client.integrations.invoke({
+          address: write.address,
+          arguments: args,
+        });
+      const before = () =>
+        integration === "approval_mcp"
+          ? mcpApi.calls.length
+          : integrationApi.requests.length;
+      expect(
+        (
+          await client.integrations.invoke({
+            address: read.address,
+            arguments: args,
+          })
+        ).status,
+        integration,
+      ).toBe("completed");
+      const noWriteCount = before();
+      expect((await invokeWrite()).status).toBe("completed");
+      expect((await invokeWrite()).status).toBe("completed");
+      expect(before()).toBe(noWriteCount + 2);
+      expect(
+        await client.integrations.invoke({
+          address: write.address.replace(".personal.", ".other."),
+          arguments: args,
+        }),
+      ).toMatchObject({ status: "completed" });
+      // The approval fallback does not override explicit native restrictions.
+      const block = await plane.integrations!.withUser(userId, (executor) =>
+        executor.policies.create({
+          owner: Owner.make("user"),
+          pattern: write.address.slice("tools.".length),
+          action: "block",
+        }),
+      );
+      if (block instanceof Error) throw block;
+      expect(await invokeWrite()).toEqual({ status: "blocked" });
+      const removed = await plane.integrations!.withUser(userId, (executor) =>
+        executor.policies.remove({ owner: Owner.make("user"), id: block.id }),
+      );
+      if (removed instanceof Error) throw removed;
+      expect(await invokeWrite()).toMatchObject({ status: "completed" });
+      expect(
+        (
+          await client.integrations.invoke({
+            address: read.address,
+            arguments: args,
+          })
+        ).status,
+      ).toBe("completed");
+    }
+    const policyCount = await plane.integrations!.withUser(userId, (executor) =>
+      executor.policies.list(),
+    );
+    if (policyCount instanceof Error) throw policyCount;
+    expect(policyCount).toHaveLength(1);
+    const closed = await plane.integrations!.close();
+    if (closed instanceof Error) throw closed;
+    const reopened = await ControlPlane.start({
+      config: {
+        deployment: "local",
+        workspace: { deployment: "local" },
+        appDataDir,
+        port: 0,
+        auth: testAuth,
+      },
+      webRoot,
+      workspaceProvider,
+      integrationEncryptionKey,
+      allowLocalIntegrationUrls: true,
+      getOpenAPISpec: async () => new Error("Must use saved catalogs"),
+    });
+    if (reopened instanceof Error) throw reopened;
+    await using cleanup = new errore.AsyncDisposableStack();
+    cleanup.defer(async () => {
+      const result = await reopened.close();
+      if (result instanceof Error) throw result;
+    });
+    const saved = await reopened.integrations!.connections(userId);
+    if (saved instanceof Error) throw saved;
+    expect(saved).toHaveLength(6);
+    const savedPolicies = await reopened.integrations!.withUser(
+      userId,
+      (executor) => executor.policies.list(),
+    );
+    expect(savedPolicies).toEqual(policyCount);
+    for (const connection of saved.filter(
+      (entry) => entry.name === "personal",
+    )) {
+      const tools = await reopened.integrations!.search({
+        userId,
+        query: "",
+        integration: connection.integration,
+      });
+      if (tools instanceof Error) throw tools;
+      const schemas = await Promise.all(
+        tools.tools
+          .filter((tool) => tool.connection === "personal")
+          .map(
+            async (tool) =>
+              await reopened.integrations!.describe({
+                userId,
+                address: tool.address,
+              }),
+          ),
+      );
+      const write = schemas.find(
+        (schema) => !(schema instanceof Error) && schema.requiresApproval,
+      );
+      if (write === undefined || write instanceof Error)
+        throw new Error("Missing persisted write tool");
+      const args: Record<string, string> =
+        connection.integration === "approval_mcp"
+          ? { marker: "after-restart" }
+          : {};
+      expect(
+        await reopened.integrations!.invoke({
+          userId,
+          address: write.address,
+          arguments: args,
+        }),
+      ).toMatchObject({ status: "completed" });
+    }
+    expect(
+      await reopened.integrations!.withUser(userId, (executor) =>
+        executor.policies.list(),
+      ),
+    ).toEqual(policyCount);
+  },
+);
+
+controlPlaneTest(
+  "discovers and invokes remote MCP tools with account isolation and native approval",
+  async ({ plane, authenticatedRpc, appDataDir, mcpApi }) => {
+    await authenticatedRpc.workspace.ensure();
+    const runtime = await readRuntimeSettings(appDataDir);
+    const client = createControlPlaneRpcClient(plane.origin, runtime.token);
+    const session = await authenticatedRpc.auth.session();
+    if (session.status !== "signed-in") throw new Error("Missing test session");
+    const userId = session.session.user.id;
+    for (const authenticated of [false, true]) {
+      const slug = authenticated ? "private-mcp" : "public-mcp";
+      const setup = await plane.integrations!.withUser(userId, (executor) =>
+        Effect.gen(function* () {
+          yield* executor.mcp.addServer({
+            name: slug,
+            slug,
+            endpoint: authenticated
+              ? mcpApi.privateEndpoint
+              : mcpApi.publicEndpoint,
+            remoteTransport: "streamable-http",
+            auth: authenticated
+              ? {
+                  kind: "header",
+                  headerName: "Authorization",
+                  prefix: "Bearer ",
+                }
+              : { kind: "none" },
+          });
+          return yield* executor.connections.create({
+            owner: Owner.make("user"),
+            name: ConnectionName.make("personal"),
+            integration: IntegrationSlug.make(slug),
+            template: AuthTemplateSlug.make(authenticated ? "header" : "none"),
+            ...(authenticated ? { value: "fixture-mcp-key" } : { values: {} }),
+          });
+        }),
+      );
+      if (setup instanceof Error) throw setup;
+      const found = await client.integrations.search({
+        query: "echo_marker",
+        integration: slug,
+      });
+      expect(found.tools).toHaveLength(1);
+      const address = found.tools[0]!.address;
+      expect(address).toBe(`tools.${slug}.user.personal.echo_marker`);
+      expect(await client.integrations.describe({ address })).toMatchObject({
+        inputSchema: {
+          properties: { marker: { type: "string" } },
+          required: ["marker"],
+        },
+      });
+      expect(
+        await client.integrations.invoke({
+          address,
+          arguments: { marker: slug },
+        }),
+      ).toEqual({
+        status: "completed",
+        result: { content: [{ type: "text", text: `MCP received: ${slug}` }] },
+      });
+      const policy = await plane.integrations!.withUser(userId, (executor) =>
+        executor.policies.create({
+          owner: Owner.make("user"),
+          pattern: `${slug}.*`,
+          action: "require_approval",
+        }),
+      );
+      if (policy instanceof Error) throw policy;
+      expect(
+        await client.integrations.invoke({
+          address,
+          arguments: { marker: "not-approved" },
+        }),
+      ).toEqual({ status: "approval_required" });
+    }
+    expect(mcpApi.calls).toEqual(["public-mcp", "private-mcp"]);
+    const bobHeaders = await createAuthenticatedHeaders(
+      appDataDir,
+      plane.origin,
+      "mcp-bob@example.com",
+    );
+    await createControlPlaneRpcClient(
+      plane.origin,
+      bobHeaders,
+    ).workspace.ensure();
+    const bob = createControlPlaneRpcClient(
+      plane.origin,
+      (await readRuntimeSettings(appDataDir)).token,
+    );
+    expect(await bob.integrations.search({ query: "echo_marker" })).toEqual({
+      tools: [],
+      truncated: false,
+    });
+    await expect(
+      bob.integrations.invoke({
+        address: "tools.private-mcp.user.personal.echo_marker",
+        arguments: { marker: "other-user" },
+      }),
+    ).rejects.toMatchObject({ code: "NOT_FOUND" });
+    const markerPath = join(appDataDir, "forbidden-mcp-process");
+    const stdio = await plane.integrations!.withUser(userId, (executor) =>
+      executor.mcp.addServer({
+        name: "Forbidden process",
+        slug: "stdio",
+        transport: "stdio",
+        command: process.execPath,
+        args: [
+          "-e",
+          `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned')`,
+        ],
+      }),
+    );
+    if (stdio instanceof Error) throw stdio;
+    // Executor can save stdio metadata, but must not start its process for discovery.
+    expect(
+      await client.integrations.search({ query: "", integration: "stdio" }),
+    ).toEqual({ tools: [], truncated: false });
+    expect(await fs.readdir(appDataDir)).not.toContain("forbidden-mcp-process");
+    expect(mcpApi.calls).toEqual(["public-mcp", "private-mcp"]);
+  },
+);
+
+controlPlaneTest(
+  "discovers and invokes only the runtime owner's integration tools through RPC",
+  async ({
+    plane,
+    authenticatedRpc,
+    rpc,
+    browserHeaders,
+    appDataDir,
+    integrationApi,
+  }) => {
+    await authenticatedRpc.workspace.ensure();
+    const runtime = await readRuntimeSettings(appDataDir);
+    const client = createControlPlaneRpcClient(plane.origin, runtime.token);
+    const session = await authenticatedRpc.auth.session();
+    if (session.status !== "signed-in") throw new Error("Missing test session");
+    const userId = session.session.user.id;
+    const setup = await plane.integrations!.withUser(userId, (executor) =>
+      Effect.gen(function* () {
+        yield* executor.openapi.addSpec({
+          slug: "rpc-api",
+          name: "RPC fixture",
+          authenticationTemplate: [
+            {
+              type: "apiKey",
+              slug: "token",
+              headers: {
+                Authorization: ["Bearer ", { type: "variable", name: "token" }],
+              },
+            },
+          ],
+          spec: {
+            kind: "blob",
+            value: JSON.stringify({
+              openapi: "3.0.0",
+              info: { title: "RPC fixture", version: "1" },
+              servers: [{ url: integrationApi.origin }],
+              paths: {
+                "/mutations/{id}": {
+                  post: {
+                    operationId: "write",
+                    description: "Write a mutation",
+                    parameters: [
+                      {
+                        name: "id",
+                        in: "path",
+                        required: true,
+                        schema: { type: "string" },
+                      },
+                    ],
+                    responses: { "200": { description: "OK" } },
+                  },
+                },
+                "/lost": {
+                  post: {
+                    operationId: "loseResponse",
+                    responses: { "200": { description: "OK" } },
+                  },
+                },
+                "/error": {
+                  post: {
+                    operationId: "fail",
+                    responses: { "200": { description: "OK" } },
+                  },
+                },
+                "/slow": {
+                  post: {
+                    operationId: "wait",
+                    responses: { "200": { description: "OK" } },
+                  },
+                },
+              },
+            }),
+          },
+        });
+        return yield* executor.connections.create({
+          owner: Owner.make("user"),
+          name: ConnectionName.make("personal"),
+          integration: IntegrationSlug.make("rpc-api"),
+          template: AuthTemplateSlug.make("token"),
+          value: "rpc-test-token",
+        });
+      }),
+    );
+    if (setup instanceof Error) throw setup;
+    const discovered = await client.integrations.search({ query: "MUTATION" });
+    expect(discovered.tools).toHaveLength(1);
+    const address = discovered.tools[0]!.address;
+    expect(discovered).toMatchObject({
+      truncated: false,
+      tools: [
+        {
+          integration: "rpc-api",
+          connection: "personal",
+          description: "Write a mutation",
+        },
+      ],
+    });
+    const schema = await client.integrations.describe({ address });
+    expect(schema).toMatchObject({
+      address,
+      inputSchema: {
+        type: "object",
+        properties: { id: { type: "string" } },
+        required: ["id"],
+      },
+    });
+    const limited = await client.integrations.search({
+      query: "",
+      integration: "rpc-api",
+      limit: 1,
+    });
+    expect(limited.tools).toHaveLength(1);
+    expect(limited.truncated).toBe(true);
+
+    for (const unauthorized of [
+      rpc,
+      authenticatedRpc,
+      createControlPlaneRpcClient(plane.origin, browserHeaders),
+    ]) {
+      await expect(
+        unauthorized.integrations.search({ query: "" }),
+      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
+      await expect(
+        unauthorized.integrations.describe({ address }),
+      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
+      await expect(
+        unauthorized.integrations.invoke({
+          address,
+          arguments: { id: "unauthorized" },
+        }),
+      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
+    }
+    await expect(
+      client.integrations.search({ query: "", limit: 101 }),
+    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
+    // A forged owner must be rejected, not accepted as extra routing metadata.
+    const forged = { query: "", userId: "someone-else" };
+    await expect(client.integrations.search(forged)).rejects.toMatchObject({
+      code: "BAD_REQUEST",
+    });
+    for (const forbidden of [
+      "executor.policies.create",
+      "executor.openapi.addSpec",
+    ]) {
+      await expect(
+        client.integrations.describe({ address: forbidden }),
+      ).rejects.toMatchObject({ code: "NOT_FOUND" });
+      await expect(
+        client.integrations.invoke({ address: forbidden, arguments: {} }),
+      ).rejects.toMatchObject({ code: "NOT_FOUND" });
+    }
+    const bobHeaders = await createAuthenticatedHeaders(
+      appDataDir,
+      plane.origin,
+      "integration-bob@example.com",
+    );
+    await createControlPlaneRpcClient(
+      plane.origin,
+      bobHeaders,
+    ).workspace.ensure();
+    const bobRuntime = await readRuntimeSettings(appDataDir);
+    const bob = createControlPlaneRpcClient(plane.origin, bobRuntime.token);
+    expect(
+      await bob.integrations.search({ query: "", integration: "rpc-api" }),
+    ).toEqual({ tools: [], truncated: false });
+    await expect(bob.integrations.describe({ address })).rejects.toMatchObject({
+      code: "NOT_FOUND",
+    });
+    await expect(
+      bob.integrations.invoke({ address, arguments: { id: "stolen" } }),
+    ).rejects.toMatchObject({ code: "NOT_FOUND" });
+    expect(
+      integrationApi.requests.filter((request) =>
+        request.url?.startsWith("/mutations/"),
+      ),
+    ).toEqual([]);
+
+    expect(
+      await client.integrations.invoke({
+        address,
+        arguments: { id: "accepted-17" },
+      }),
+    ).toEqual({ status: "completed", result: { written: "accepted-17" } });
+    const invalid = await client.integrations.invoke({
+      address,
+      arguments: { id: "invalid", unexpected: true },
+    });
+    expect(invalid.status).toBe("failed");
+    const policy = await plane.integrations!.withUser(userId, (executor) =>
+      executor.policies.create({
+        owner: Owner.make("user"),
+        pattern: address.slice("tools.".length),
+        action: "block",
+      }),
+    );
+    if (policy instanceof Error) throw policy;
+    expect(
+      await client.integrations.invoke({
+        address,
+        arguments: { id: "blocked" },
+      }),
+    ).toEqual({ status: "blocked" });
+    expect(await client.integrations.search({ query: "MUTATION" })).toEqual({
+      tools: [],
+      truncated: false,
+    });
+    await expect(
+      client.integrations.describe({ address }),
+    ).rejects.toMatchObject({ code: "NOT_FOUND" });
+    const changed = await plane.integrations!.withUser(userId, (executor) =>
+      executor.policies.update({
+        id: policy.id,
+        owner: Owner.make("user"),
+        action: "require_approval",
+      }),
+    );
+    if (changed instanceof Error) throw changed;
+    expect(
+      await client.integrations.invoke({
+        address,
+        arguments: { id: "unapproved" },
+      }),
+    ).toEqual({ status: "approval_required" });
+    expect(
+      integrationApi.requests.filter((request) =>
+        request.url?.startsWith("/mutations/"),
+      ),
+    ).toEqual([
+      { url: "/mutations/accepted-17", authorization: "Bearer rpc-test-token" },
+    ]);
+
+    const tools = await client.integrations.search({
+      query: "",
+      integration: "rpc-api",
+    });
+    const lost = tools.tools.find((tool) =>
+      tool.name.includes("loseResponse"),
+    )!;
+    expect(
+      await client.integrations.invoke({
+        address: lost.address,
+        arguments: {},
+      }),
+    ).toMatchObject({ status: "failed", code: "outcome_unknown" });
+    expect(
+      integrationApi.requests.filter((request) => request.url === "/lost"),
+    ).toHaveLength(1);
+    const failed = tools.tools.find((tool) => tool.name.endsWith("fail"))!;
+    expect(
+      await client.integrations.invoke({
+        address: failed.address,
+        arguments: {},
+      }),
+    ).toMatchObject({ status: "failed", code: "tool_failed" });
+    const slow = tools.tools.find((tool) => tool.name.endsWith("wait"))!;
+    const controller = new AbortController();
+    const waiting = client.integrations.invoke(
+      { address: slow.address, arguments: {} },
+      { signal: controller.signal },
+    );
+    const cancelled = expect(waiting).rejects.toThrow();
+    await expect
+      .poll(
+        () =>
+          integrationApi.requests.filter((request) => request.url === "/slow")
+            .length,
+      )
+      .toBe(1);
+    controller.abort();
+    await cancelled;
+    await expect.poll(() => integrationApi.disconnected).toEqual(["/slow"]);
+    await authenticatedRpc.workspace.rotateRuntimeToken();
+    await expect(
+      client.integrations.invoke({ address, arguments: { id: "rotated" } }),
+    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
+    const rotated = await readRuntimeSettings(appDataDir);
+    expect(
+      (
+        await createControlPlaneRpcClient(
+          plane.origin,
+          rotated.token,
+        ).integrations.search({ query: "MUTATION" })
+      ).tools,
+    ).toHaveLength(1);
+  },
+);
+
 controlPlaneTest(
   "persists user-bound integration catalogs and native policies after restart",
   async ({ appDataDir, webRoot, workspaceProvider, integrationApi }) => {
@@ -301,6 +1661,7 @@ controlPlaneTest(
       webRoot,
       workspaceProvider,
       integrationEncryptionKey,
+      allowLocalIntegrationUrls: true,
       getOpenAPISpec,
     });
     if (plane instanceof Error) throw plane;
@@ -376,7 +1737,7 @@ controlPlaneTest(
       await integrations.withUser("bob", (executor) =>
         executor.policies.list(),
       ),
-    ).toEqual([]);
+    ).toMatchObject([{ owner: "org", pattern: "*", action: "approve" }]);
     expect(
       await integrations.withUser("bob", (executor) =>
         executor.integrations.get(IntegrationSlug.make("private-api")),
@@ -392,6 +1753,7 @@ controlPlaneTest(
       webRoot,
       workspaceProvider,
       integrationEncryptionKey,
+      allowLocalIntegrationUrls: true,
       getOpenAPISpec: async () =>
         new Error("Persisted presets must not fetch again"),
     });
@@ -400,11 +1762,23 @@ controlPlaneTest(
       const reopenedClosed = await reopened.close();
       if (reopenedClosed instanceof Error) throw reopenedClosed;
     });
+    expect(await reopened.integrations!.connections("alice")).toMatchObject([
+      { address: connection.address },
+    ]);
     expect(
       await reopened.integrations!.withUser("alice", (executor) =>
         executor.policies.list(),
       ),
-    ).toEqual([policy]);
+    ).toEqual(
+      expect.arrayContaining([
+        policy,
+        expect.objectContaining({
+          owner: "org",
+          pattern: "*",
+          action: "approve",
+        }),
+      ]),
+    );
     const persisted = await reopened.integrations!.withUser(
       "alice",
       (executor) =>
@@ -448,7 +1822,9 @@ controlPlaneTest(
       ),
     ).toBeInstanceOf(Error);
     resume.resolve();
-    expect(await work).toEqual([]);
+    expect(await work).toMatchObject([
+      { owner: "org", pattern: "*", action: "approve" },
+    ]);
     expect(await closing).toBeUndefined();
   },
 );

```

```source-diff:current-router:apps/control-plane/src/server/controlPlaneRpcRouter.ts
diff --git a/apps/control-plane/src/server/controlPlaneRpcRouter.ts b/apps/control-plane/src/server/controlPlaneRpcRouter.ts
index 58fcaa0..f1c6d3e 100644
--- a/apps/control-plane/src/server/controlPlaneRpcRouter.ts
+++ b/apps/control-plane/src/server/controlPlaneRpcRouter.ts
@@ -14,14 +14,22 @@ import {
   type AuthService,
   InvalidDesktopAuthCodeError,
   InvalidDesktopSignInRequestError,
+  WorkspaceAuthenticationRequiredError,
 } from "../auth/AuthService.js";
 import type { WorkspaceService } from "../workspace/WorkspaceService.js";
+import {
+  IntegrationToolNotFoundError,
+  IntegrationSetupError,
+  type IntegrationService,
+} from "../integrations/IntegrationService.js";
 
 export type ControlPlaneContext = RequestHeadersHandlerPluginContext &
   ResponseHeadersHandlerPluginContext & {
     build?: { version: string; revision: string };
+    publicOrigin: string;
     auth: AuthService;
     workspace: WorkspaceService;
+    integrations?: IntegrationService;
   };
 
 const implementer =
@@ -43,6 +51,82 @@ const os = implementer.use(({ context, next }) => {
   return next();
 });
 
+const loadRuntime = implementer.middleware(async ({ context, next }) => {
+  const identity = await context.workspace.authenticateRuntimeOwner(
+    context.reqHeaders ?? new Headers(),
+  );
+  if (identity instanceof WorkspaceAuthenticationRequiredError)
+    throw new ORPCError("UNAUTHORIZED");
+  if (identity instanceof Error) throw internalError(identity);
+  if (context.integrations === undefined)
+    throw new ORPCError("SERVICE_UNAVAILABLE");
+  return await next({
+    context: {
+      ownerUserId: identity.ownerUserId,
+      integrations: context.integrations,
+    },
+  });
+});
+
+const loadIntegrationUser = implementer.middleware(
+  async ({ context, next }) => {
+    const headers = context.reqHeaders ?? new Headers();
+    const origin = headers.get("origin");
+    // Browser cookies require same-origin requests. Desktop bearer sessions are not ambient.
+    if (origin !== null && origin !== context.publicOrigin)
+      throw new ORPCError("FORBIDDEN");
+    if (origin === null && !headers.get("authorization")?.startsWith("Bearer "))
+      throw new ORPCError("FORBIDDEN");
+    const session = await context.auth.getSession(headers);
+    if (session instanceof Error) throw internalError(session);
+    if (session === undefined) throw new ORPCError("UNAUTHORIZED");
+    if (context.integrations === undefined)
+      throw new ORPCError("SERVICE_UNAVAILABLE");
+    return await next({
+      context: {
+        ownerUserId: session.user.id,
+        integrations: context.integrations,
+      },
+    });
+  },
+);
+
+const loadIntegrationOwner = implementer.middleware(
+  async ({ context, next }) => {
+    const headers = context.reqHeaders ?? new Headers();
+    const session = await context.auth.getSession(headers);
+    if (session instanceof Error) throw internalError(session);
+    const runtime =
+      session === undefined
+        ? await context.workspace.authenticateRuntimeOwner(headers)
+        : undefined;
+    if (runtime instanceof WorkspaceAuthenticationRequiredError)
+      throw new ORPCError("UNAUTHORIZED");
+    if (runtime instanceof Error) throw internalError(runtime);
+    if (context.integrations === undefined)
+      throw new ORPCError("SERVICE_UNAVAILABLE");
+    if (
+      session !== undefined &&
+      headers.get("origin") !== null &&
+      headers.get("origin") !== context.publicOrigin
+    )
+      throw new ORPCError("FORBIDDEN");
+    return await next({
+      context: {
+        ownerUserId: session?.user.id ?? runtime!.ownerUserId,
+        integrations: context.integrations,
+      },
+    });
+  },
+);
+
+function integrationError(result: Error): never {
+  if (result instanceof IntegrationSetupError) throw badRequest(result);
+  if (result instanceof IntegrationToolNotFoundError)
+    throw new ORPCError("NOT_FOUND");
+  throw internalError(result);
+}
+
 const getServerInfo = os.server.info.handler(({ context }) => ({
   protocolVersion: controlPlaneProtocolVersion,
   supportedProtocols: controlPlaneSupportedProtocols,
@@ -103,6 +187,114 @@ const ensureWorkspace = os.workspace.ensure
   });
 
 export const controlPlaneRpcRouter = os.router({
+  integrations: os.integrations.router({
+    catalog: os.integrations.catalog
+      .use(loadIntegrationOwner)
+      .handler(async ({ context }) => {
+        const result = await context.integrations.catalog(context.ownerUserId);
+        if (result instanceof Error) return integrationError(result);
+        return result;
+      }),
+    startSetup: os.integrations.startSetup
+      .use(loadIntegrationOwner)
+      .handler(async ({ context, input }) => {
+        const result = await context.integrations.startSetup({
+          ...input,
+          userId: context.ownerUserId,
+        });
+        if (result instanceof Error) return integrationError(result);
+        return result;
+      }),
+    setup: os.integrations.setup
+      .use(loadIntegrationOwner)
+      .handler(async ({ context, input }) => {
+        const result = await context.integrations.setup({
+          ...input,
+          userId: context.ownerUserId,
+        });
+        if (result instanceof Error) return integrationError(result);
+        return result;
+      }),
+    cancelSetup: os.integrations.cancelSetup
+      .use(loadIntegrationOwner)
+      .handler(async ({ context, input }) => {
+        const result = await context.integrations.cancelSetup({
+          ...input,
+          userId: context.ownerUserId,
+        });
+        if (result instanceof Error) return integrationError(result);
+      }),
+    submitSetup: os.integrations.submitSetup
+      .use(loadIntegrationUser)
+      .handler(async ({ context, input }) => {
+        const result = await context.integrations.submitSetup({
+          ...input,
+          userId: context.ownerUserId,
+        });
+        if (result instanceof Error) return integrationError(result);
+        return result;
+      }),
+    registerOpenAPI: os.integrations.registerOpenAPI
+      .use(loadIntegrationUser)
+      .handler(async ({ context, input }) => {
+        const result = await context.integrations.registerOpenAPI({
+          ...input,
+          userId: context.ownerUserId,
+        });
+        if (result instanceof Error) return integrationError(result);
+      }),
+    registerMcp: os.integrations.registerMcp
+      .use(loadIntegrationUser)
+      .handler(async ({ context, input }) => {
+        const result = await context.integrations.registerMcp({
+          ...input,
+          userId: context.ownerUserId,
+        });
+        if (result instanceof Error) return integrationError(result);
+      }),
+    connections: os.integrations.connections
+      .use(loadIntegrationUser)
+      .handler(async ({ context }) => {
+        const result = await context.integrations.connections(
+          context.ownerUserId,
+        );
+        if (result instanceof Error) return integrationError(result);
+        return result;
+      }),
+    search: os.integrations.search
+      .use(loadRuntime)
+      .handler(async ({ context, input, signal }) => {
+        const result = await context.integrations.search({
+          ...input,
+          userId: context.ownerUserId,
+          signal,
+        });
+        if (result instanceof Error) return integrationError(result);
+        return result;
+      }),
+    describe: os.integrations.describe
+      .use(loadRuntime)
+      .handler(async ({ context, input, signal }) => {
+        const result = await context.integrations.describe({
+          ...input,
+          userId: context.ownerUserId,
+          signal,
+        });
+        if (result instanceof Error) return integrationError(result);
+        return result;
+      }),
+    invoke: os.integrations.invoke
+      .use(loadRuntime)
+      .handler(async ({ context, input, signal }) => {
+        const result = await context.integrations.invoke({
+          ...input,
+          userId: context.ownerUserId,
+          signal,
+        });
+        if (result instanceof Error) return integrationError(result);
+        return result;
+      }),
+  }),
   server: os.server.router({
     info: getServerInfo,
   }),

```

```source-diff:current-contract:packages/shared/src/controlPlaneContract.ts
diff --git a/packages/shared/src/controlPlaneContract.ts b/packages/shared/src/controlPlaneContract.ts
index 02b5c02..11881b9 100644
--- a/packages/shared/src/controlPlaneContract.ts
+++ b/packages/shared/src/controlPlaneContract.ts
@@ -1,6 +1,87 @@
 import * as errore from "errore";
 import { checkServerCompatibility, type ServerInfo } from "@get-halo/client";
 import { error, oc, type, type RouterContractClient } from "@orpc/contract";
+import { Type, type Static, type TSchema } from "@sinclair/typebox";
+import { Value } from "@sinclair/typebox/value";
+
+const jsonValueSchema = Type.Recursive((self) =>
+  Type.Union([
+    Type.Null(),
+    Type.Boolean(),
+    Type.Number(),
+    Type.String(),
+    Type.Array(self),
+    Type.Record(Type.String(), self),
+  ]),
+);
+export type IntegrationJson = Static<typeof jsonValueSchema>;
+export type IntegrationSetupMethod = {
+  template: string;
+  label: string;
+  kind: "oauth" | "apikey" | "header" | "none";
+  fields: string[];
+};
+export type IntegrationSetupCatalogEntry = {
+  integration: string;
+  name: string;
+  methods: IntegrationSetupMethod[];
+};
+export type IntegrationSetup = IntegrationSetupCatalogEntry & {
+  setupId: string;
+  connectionName: string;
+  status:
+    | "awaiting_credentials"
+    | "authorizing"
+    | "ready"
+    | "cancelled"
+    | "expired"
+    | "failed";
+  connection?: IntegrationConnection;
+  message?: string;
+};
+export type IntegrationConnection = {
+  address: string;
+  integration: string;
+  name: string;
+  accountLabel?: string;
+};
+export type IntegrationTool = {
+  address: string;
+  integration: string;
+  connection: string;
+  name: string;
+  description: string;
+};
+export type IntegrationToolSchema = IntegrationTool & {
+  inputSchema?: IntegrationJson;
+  outputSchema?: IntegrationJson;
+  schemaDefinitions?: IntegrationJson;
+  requiresApproval?: boolean;
+};
+export type IntegrationInvocation =
+  | { status: "completed"; result: IntegrationJson }
+  | { status: "blocked" | "approval_required" | "connection_required" }
+  | {
+      status: "failed";
+      code: "tool_failed" | "unsupported_interaction" | "outcome_unknown";
+      message: string;
+    };
+
+function validated<T extends TSchema>(schema: T) {
+  return {
+    "~standard": {
+      version: 1 as const,
+      vendor: "halo-typebox",
+      validate: (
+        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Standard Schema receives untrusted RPC input here.
+        value: unknown,
+      ): { value: Static<T> } | { issues: { message: string }[] } =>
+        Value.Check(schema, value)
+          ? { value }
+          : { issues: [{ message: "Invalid integration request" }] },
+    },
+  };
+}
 
 export const controlPlaneProtocolVersion = 3 as const;
 export const controlPlaneSupportedProtocols = [controlPlaneProtocolVersion];
@@ -69,6 +150,139 @@ export const controlPlaneContract = publicProcedure.router({
     rotateRuntimeToken:
       authenticatedProcedure.output(type<ControlPlaneWorkspace>()),
   },
+  integrations: {
+    catalog:
+      authenticatedProcedure.output(type<IntegrationSetupCatalogEntry[]>()),
+    startSetup: authenticatedProcedure
+      .input(
+        validated(
+          Type.Object(
+            {
+              integration: Type.String({ minLength: 1, maxLength: 256 }),
+              connectionName: Type.Optional(
+                Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" }),
+              ),
+            },
+            { additionalProperties: false },
+          ),
+        ),
+      )
+      .output(type<{ setupId: string; setupUrl: string }>()),
+    setup: authenticatedProcedure
+      .input(
+        validated(
+          Type.Object(
+            { setupId: Type.String({ minLength: 1, maxLength: 128 }) },
+            { additionalProperties: false },
+          ),
+        ),
+      )
+      .output(type<IntegrationSetup>()),
+    submitSetup: authenticatedProcedure
+      .input(
+        validated(
+          Type.Object(
+            {
+              setupId: Type.String({ minLength: 1, maxLength: 128 }),
+              template: Type.String({ minLength: 1, maxLength: 256 }),
+              values: Type.Optional(
+                Type.Record(
+                  Type.String({ maxLength: 128 }),
+                  Type.String({ maxLength: 65536 }),
+                ),
+              ),
+            },
+            { additionalProperties: false },
+          ),
+        ),
+      )
+      .output(type<{ authorizationUrl?: string }>()),
+    cancelSetup: authenticatedProcedure
+      .input(
+        validated(
+          Type.Object(
+            { setupId: Type.String({ minLength: 1, maxLength: 128 }) },
+            { additionalProperties: false },
+          ),
+        ),
+      )
+      .output(type<void>()),
+    registerOpenAPI: authenticatedProcedure
+      .input(
+        validated(
+          Type.Object(
+            {
+              name: Type.String({ minLength: 1, maxLength: 256 }),
+              slug: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
+              url: Type.String({ minLength: 1, maxLength: 2048 }),
+            },
+            { additionalProperties: false },
+          ),
+        ),
+      )
+      .output(type<void>()),
+    registerMcp: authenticatedProcedure
+      .input(
+        validated(
+          Type.Object(
+            {
+              name: Type.String({ minLength: 1, maxLength: 256 }),
+              slug: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
+              endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
+              auth: Type.Union([
+                Type.Literal("none"),
+                Type.Literal("bearer"),
+                Type.Literal("oauth"),
+              ]),
+            },
+            { additionalProperties: false },
+          ),
+        ),
+      )
+      .output(type<void>()),
+    connections: authenticatedProcedure.output(type<IntegrationConnection[]>()),
+    search: authenticatedProcedure
+      .input(
+        validated(
+          Type.Object(
+            {
+              query: Type.String({ maxLength: 1024 }),
+              integration: Type.Optional(
+                Type.String({ minLength: 1, maxLength: 256 }),
+              ),
+              limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
+            },
+            { additionalProperties: false },
+          ),
+        ),
+      )
+      .output(type<{ tools: IntegrationTool[]; truncated: boolean }>()),
+    describe: authenticatedProcedure
+      .input(
+        validated(
+          Type.Object(
+            {
+              address: Type.String({ minLength: 1, maxLength: 2048 }),
+            },
+            { additionalProperties: false },
+          ),
+        ),
+      )
+      .output(type<IntegrationToolSchema>()),
+    invoke: authenticatedProcedure
+      .input(
+        validated(
+          Type.Object(
+            {
+              address: Type.String({ minLength: 1, maxLength: 2048 }),
+              arguments: Type.Record(Type.String(), jsonValueSchema),
+            },
+            { additionalProperties: false },
+          ),
+        ),
+      )
+      .output(type<IntegrationInvocation>()),
+  },
 });
 
 export type ControlPlaneClient = RouterContractClient<

```

```source-diff:current-host:apps/control-plane/src/server/ControlPlane.ts
diff --git a/apps/control-plane/src/server/ControlPlane.ts b/apps/control-plane/src/server/ControlPlane.ts
index 47168d2..d88a572 100644
--- a/apps/control-plane/src/server/ControlPlane.ts
+++ b/apps/control-plane/src/server/ControlPlane.ts
@@ -57,6 +57,7 @@ export class ControlPlane {
     workspaceIdleTimeoutMs?: number;
     integrationEncryptionKey?: Buffer;
     getOpenAPISpec?: (url: string) => Promise<string | Error>;
+    allowLocalIntegrationUrls?: boolean;
   }) {
     const { config, webRoot } = ctx;
     await using cleanup = new errore.AsyncDisposableStack();
@@ -116,6 +117,20 @@ export class ControlPlane {
             db,
             credentials,
             getOpenAPISpec: ctx.getOpenAPISpec,
+            publicOrigin,
+            allowLocalUrls:
+              config.deployment === "local" &&
+              ctx.allowLocalIntegrationUrls === true,
+            firstPartyOAuthClients: [
+              {
+                name: "google",
+                authorizationUrl:
+                  "https://accounts.google.com/o/oauth2/v2/auth",
+                tokenUrl: "https://oauth2.googleapis.com/token",
+                clientId: config.auth.googleClientId,
+                clientSecret: config.auth.googleClientSecret,
+              },
+            ],
           });
     if (integrations instanceof Error) return integrations;
     cleanup.defer(async () => {
@@ -128,6 +143,7 @@ export class ControlPlane {
       auth,
       publicOrigin,
       workspace,
+      integrations,
       webRoot,
       build: ctx.build,
       inferenceApiKey: ctx.inferenceApiKey,

```

```source-diff:current-http:apps/control-plane/src/server/controlPlaneHttp.ts
diff --git a/apps/control-plane/src/server/controlPlaneHttp.ts b/apps/control-plane/src/server/controlPlaneHttp.ts
index 992a6a3..109f06d 100644
--- a/apps/control-plane/src/server/controlPlaneHttp.ts
+++ b/apps/control-plane/src/server/controlPlaneHttp.ts
@@ -32,6 +32,7 @@ import {
 } from "./controlPlaneRpcRouter.js";
 import type { TraceIngestion } from "../traces/TraceIngestion.js";
 import type { WorkspaceService } from "../workspace/WorkspaceService.js";
+import type { IntegrationService } from "../integrations/IntegrationService.js";
 import {
   isWorkspaceProxyRequest,
   WorkspaceGateway,
@@ -100,6 +101,7 @@ export function serveControlPlaneHttp(ctx: {
   auth: AuthService;
   publicOrigin: string;
   workspace: WorkspaceService;
+  integrations?: IntegrationService;
   build?: { version: string; revision: string };
   webRoot: string;
   traces?: TraceIngestion;
@@ -141,6 +143,8 @@ export function serveControlPlaneHttp(ctx: {
       gateway,
       traces,
       rpc,
+      integrations: ctx.integrations,
+      publicOrigin,
       webRoot,
       build: ctx.build,
       inferenceApiKey: ctx.inferenceApiKey,
@@ -201,10 +205,12 @@ async function routeControlPlaneRequest(ctx: {
   request: IncomingMessage;
   response: ServerResponse;
   auth: AuthService;
+  publicOrigin: string;
   gateway: WorkspaceGateway;
   traces?: TraceIngestion;
   inferenceApiKey?: string;
   workspace: WorkspaceService;
+  integrations?: IntegrationService;
   build?: { version: string; revision: string };
   rpc: RPCHandler<ControlPlaneContext>;
   webRoot: string;
@@ -215,6 +221,28 @@ async function routeControlPlaneRequest(ctx: {
     requestUrlBase,
   );
 
+  if (
+    request.method === "GET" &&
+    url.pathname === "/api/integrations/oauth/callback"
+  ) {
+    const result = await ctx.integrations?.oauthCallback({
+      state: url.searchParams.get("state") ?? "",
+      code: url.searchParams.has("error")
+        ? undefined
+        : (url.searchParams.get("code") ?? undefined),
+    });
+    response.setHeader("cache-control", "no-store");
+    response.setHeader("referrer-policy", "no-referrer");
+    if (result === undefined || result instanceof Error) {
+      response.writeHead(400, { "content-type": "text/plain" });
+      response.end("Invalid or expired authorization callback.");
+      return;
+    }
+    response.writeHead(303, { location: result.setupUrl });
+    response.end();
+    return;
+  }
+
   if (url.pathname === "/api/workspace-runtime/idle") {
     await serveWorkspaceIdleReport(request, response, workspace);
     return;
@@ -301,8 +329,10 @@ async function routeControlPlaneRequest(ctx: {
       request,
       response,
       auth,
+      publicOrigin: ctx.publicOrigin,
       workspace,
       rpc,
+      integrations: ctx.integrations,
       build: ctx.build,
     });
     return;
@@ -439,14 +469,22 @@ async function serveControlPlaneRpc(ctx: {
   request: IncomingMessage;
   response: ServerResponse;
   auth: AuthService;
+  publicOrigin: string;
   workspace: WorkspaceService;
+  integrations?: IntegrationService;
   build?: { version: string; revision: string };
   rpc: RPCHandler<ControlPlaneContext>;
 }) {
   const { request, response, auth, workspace, rpc } = ctx;
   const handled = await rpc.handle(request, response, {
     prefix: "/rpc",
-    context: { auth, workspace, build: ctx.build },
+    context: {
+      auth,
+      publicOrigin: ctx.publicOrigin,
+      workspace,
+      integrations: ctx.integrations,
+      build: ctx.build,
+    },
   });
 
   if (handled.matched) return;

```

```source-diff:current-auth:apps/control-plane/src/workspace/WorkspaceService.ts
diff --git a/apps/control-plane/src/workspace/WorkspaceService.ts b/apps/control-plane/src/workspace/WorkspaceService.ts
index 726bc83..9f13a2c 100644
--- a/apps/control-plane/src/workspace/WorkspaceService.ts
+++ b/apps/control-plane/src/workspace/WorkspaceService.ts
@@ -145,7 +145,7 @@ export class WorkspaceService {
     return { workspaceId: identity.workspaceId };
   }
 
-  private async authenticateRuntimeOwner(headers: Headers) {
+  async authenticateRuntimeOwner(headers: Headers) {
     const identity = await this.auth.verifyWorkspaceToken(headers);
     if (identity instanceof Error) return identity;
     const workspace = await this.findRecord(identity.userId);

```

```source-diff:current-deps:apps/control-plane/package.json
diff --git a/apps/control-plane/package.json b/apps/control-plane/package.json
index f414afd..0d7bcae 100644
--- a/apps/control-plane/package.json
+++ b/apps/control-plane/package.json
@@ -18,6 +18,7 @@
   "dependencies": {
     "@better-auth/api-key": "1.7.4",
     "@executor-js/fumadb": "1.5.7",
+    "@executor-js/plugin-mcp": "1.6.0",
     "@executor-js/plugin-openapi": "1.6.0",
     "@executor-js/sdk": "1.6.0",
     "@get-halo/client": "workspace:*",
@@ -37,6 +38,7 @@
   },
   "devDependencies": {
     "@get-halo/typescript-config": "workspace:*",
+    "@modelcontextprotocol/sdk": "1.30.0",
     "@orpc/client": "2.0.0-beta.29",
     "@types/node": "^22.20.1",
     "@types/pg": "^8.23.1",

```

```source-diff:setup-page:packages/web/src/IntegrationSetupPage.tsx
diff --git a/packages/web/src/IntegrationSetupPage.tsx b/packages/web/src/IntegrationSetupPage.tsx
new file mode 100644
index 0000000..b2736e3
--- /dev/null
+++ b/packages/web/src/IntegrationSetupPage.tsx
@@ -0,0 +1,278 @@
+import { useState } from "react";
+import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
+import {
+  Button,
+  Flex,
+  H2,
+  P,
+  RadioOption,
+  RadioOptionGroup,
+  Text,
+  TextField,
+  proseContainerStyle,
+} from "maui";
+import { style, useStyles } from "purse-styles";
+import type { IntegrationSetup } from "@get-halo/shared/controlPlaneContract";
+import type { HostApi } from "./HostApi.js";
+
+const page = style(proseContainerStyle, {
+  width: "100%",
+  maxWidth: "480px",
+  marginInline: "auto",
+  padding: "64px 24px",
+  boxSizing: "border-box",
+});
+
+type SetupApi = NonNullable<HostApi["integrationSetup"]>;
+
+export function IntegrationSetupPage({
+  setupId,
+  api,
+}: {
+  setupId: string;
+  api: SetupApi;
+}) {
+  const className = useStyles(page);
+  const queryClient = useQueryClient();
+  const queryKey = ["integration-setup", setupId];
+  const setup = useQuery({
+    queryKey,
+    queryFn: async () => {
+      const result = await api.read(setupId);
+      if (result instanceof Error) throw result;
+      return result;
+    },
+    refetchInterval: (query) =>
+      query.state.data?.status === "authorizing" ||
+      query.state.data?.status === "awaiting_credentials"
+        ? 1500
+        : false,
+  });
+  const cancel = useMutation({
+    mutationFn: async () => {
+      const result = await api.cancel(setupId);
+      if (result instanceof Error) throw result;
+    },
+    onSuccess: async () => {
+      await queryClient.invalidateQueries({ queryKey });
+    },
+  });
+  const data = setup.data;
+  return (
+    <main className={className}>
+      <Flex column gap={8}>
+        <Text size="sm" color="lowContrast">
+          Halo connections
+        </Text>
+        <H2>
+          {data === undefined
+            ? "Connect an account"
+            : data.status === "ready"
+              ? `${data.name} connected`
+              : `Connect ${data.name}`}
+        </H2>
+        {setup.isPending && <P>Loading connection details…</P>}
+        {setup.isError && (
+          <>
+            <div role="alert">
+              <P>
+                This connection setup is unavailable. Make sure you are signed
+                in to the Halo account that requested it.
+              </P>
+            </div>
+            <Button
+              onClick={async () => {
+                await setup.refetch();
+              }}
+            >
+              Try again
+            </Button>
+          </>
+        )}
+        {data !== undefined && (
+          <>
+            <Text size="sm" color="lowContrast">
+              Connection: {data.connectionName}
+            </Text>
+            {data.status === "awaiting_credentials" && (
+              <SetupForm
+                key={setupId}
+                setup={data}
+                api={api}
+                onSaved={async () => {
+                  await queryClient.invalidateQueries({ queryKey });
+                }}
+              />
+            )}
+            {data.status === "authorizing" && (
+              <div role="status">
+                <P>
+                  Waiting for authorization. Complete sign-in with the provider,
+                  or cancel and start again from Halo.
+                </P>
+              </div>
+            )}
+            {data.status === "ready" && (
+              <>
+                <div role="status">
+                  <P>
+                    Your connection is ready. You can close this tab and return
+                    to Halo.
+                  </P>
+                </div>
+                {data.connection?.accountLabel && (
+                  <Text>{data.connection.accountLabel}</Text>
+                )}
+              </>
+            )}
+            {data.status === "cancelled" && (
+              <div role="status">
+                <P>
+                  Connection cancelled. No new connection was created. You can
+                  start again from Halo.
+                </P>
+              </div>
+            )}
+            {data.status === "expired" && (
+              <div role="status">
+                <P>
+                  This setup has expired. Return to Halo and click Connect to
+                  start again.
+                </P>
+              </div>
+            )}
+            {data.status === "failed" && (
+              <div role="alert">
+                <P>
+                  {data.message ??
+                    "Connection setup failed. Return to Halo to try again."}
+                </P>
+              </div>
+            )}
+            {(data.status === "awaiting_credentials" ||
+              data.status === "authorizing") && (
+              <Button
+                variant="quiet"
+                isDisabled={cancel.isPending}
+                onClick={() => cancel.mutate()}
+              >
+                Cancel connection
+              </Button>
+            )}
+            {cancel.isError && (
+              <div role="alert">
+                <P>
+                  Could not cancel. Connection setup may already be completing.
+                  Refresh its status before trying again.
+                </P>
+              </div>
+            )}
+          </>
+        )}
+      </Flex>
+    </main>
+  );
+}
+
+function SetupForm({
+  setup,
+  api,
+  onSaved,
+}: {
+  setup: IntegrationSetup;
+  api: SetupApi;
+  onSaved(): Promise<void>;
+}) {
+  const [template, setTemplate] = useState(setup.methods[0]?.template ?? "");
+  const [values, setValues] = useState<Record<string, string>>({});
+  const method = setup.methods.find((entry) => entry.template === template);
+  const submit = useMutation({
+    mutationFn: async () => {
+      const result = await api.submit({
+        setupId: setup.setupId,
+        template,
+        values,
+      });
+      setValues({});
+      if (result instanceof Error) throw result;
+      if (result.authorizationUrl !== undefined)
+        window.location.assign(result.authorizationUrl);
+    },
+    onSettled: onSaved,
+  });
+  return (
+    <form
+      onSubmit={(event) => {
+        event.preventDefault();
+        submit.mutate();
+      }}
+    >
+      <Flex column gap={8}>
+        <P>
+          Connecting lets your agents and background extensions use this
+          account’s tools, including actions that change data, within the access
+          you grant. There are no additional per-action approval prompts.
+        </P>
+        {setup.methods.length > 1 && (
+          <RadioOptionGroup
+            label="Authentication method"
+            value={template}
+            onChange={(value) => {
+              setTemplate(value);
+              setValues({});
+            }}
+            isDisabled={submit.isPending}
+          >
+            {setup.methods.map((entry) => (
+              <RadioOption key={entry.template} value={entry.template}>
+                {entry.label}
+              </RadioOption>
+            ))}
+          </RadioOptionGroup>
+        )}
+        {method?.fields.map((field) => (
+          <Flex column gap={3} key={field}>
+            <label htmlFor={`credential-${field}`}>{field}</label>
+            <TextField
+              id={`credential-${field}`}
+              aria-label={field}
+              type="password"
+              autoComplete="off"
+              isRequired
+              isDisabled={submit.isPending}
+              value={values[field] ?? ""}
+              onChange={(value) =>
+                setValues((current) => ({ ...current, [field]: value }))
+              }
+            />
+          </Flex>
+        ))}
+        {method !== undefined && method.fields.length > 0 && (
+          <Text size="sm" color="lowContrast">
+            Credentials are encrypted on Halo’s control plane. They are not sent
+            to the agent or workspace.
+          </Text>
+        )}
+        {submit.isError && (
+          <div role="alert">
+            <P>
+              Could not complete setup. Check the connection status or start
+              again from Halo.
+            </P>
+          </div>
+        )}
+        <Button
+          type="submit"
+          variant="primary"
+          isDisabled={method === undefined || submit.isPending}
+        >
+          {submit.isPending
+            ? "Connecting…"
+            : method?.kind === "oauth"
+              ? `Continue to ${setup.name}`
+              : "Connect"}
+        </Button>
+      </Flex>
+    </form>
+  );
+}

```

```source-diff:setup-route:packages/web/src/mountHaloApp.tsx
diff --git a/packages/web/src/mountHaloApp.tsx b/packages/web/src/mountHaloApp.tsx
index dc784f6..f450146 100644
--- a/packages/web/src/mountHaloApp.tsx
+++ b/packages/web/src/mountHaloApp.tsx
@@ -10,6 +10,7 @@ import { HaloApp } from "./HaloApp.tsx";
 import { Authentication } from "./Authentication.tsx";
 import { StandaloneExtension } from "./StandaloneExtension.js";
 import { ApiProvider } from "./api/ApiProvider.tsx";
+import { IntegrationSetupPage } from "./IntegrationSetupPage.js";
 import "./css.js";
 // Document shell (html/body/#root) must apply before React; purse-styles injects in layout effect.
 import "./styles.css";
@@ -33,12 +34,26 @@ export function mountHaloApp(root: HTMLElement, host: HostApi) {
         <MauiProvider>
           <QueryClientProvider client={queryClient}>
             <Authentication>
-              <ApiProvider>
-                <HaloRoutes />
-                {import.meta.env.DEV && (
-                  <Agentation endpoint="http://127.0.0.1:4747" />
+              <Switch>
+                {host.integrationSetup !== undefined && (
+                  <Route path="/integrations/setup/:setupId">
+                    {(params) => (
+                      <IntegrationSetupPage
+                        setupId={params.setupId}
+                        api={host.integrationSetup!}
+                      />
+                    )}
+                  </Route>
                 )}
-              </ApiProvider>
+                <Route>
+                  <ApiProvider>
+                    <HaloRoutes />
+                    {import.meta.env.DEV && (
+                      <Agentation endpoint="http://127.0.0.1:4747" />
+                    )}
+                  </ApiProvider>
+                </Route>
+              </Switch>
             </Authentication>
           </QueryClientProvider>
         </MauiProvider>

```

```source-diff:setup-host-api:packages/web/src/HostApi.ts
diff --git a/packages/web/src/HostApi.ts b/packages/web/src/HostApi.ts
index 23a1015..6989204 100644
--- a/packages/web/src/HostApi.ts
+++ b/packages/web/src/HostApi.ts
@@ -7,6 +7,7 @@ import type {
 import type {
   ControlPlaneWorkspaceStatus,
   ControlPlaneSession,
+  IntegrationSetup,
 } from "@get-halo/shared/controlPlaneContract";
 import type { ShortcutId } from "./shortcuts.js";
 
@@ -25,6 +26,15 @@ export type AppInfo = {
 };
 
 export interface HostApi {
+  integrationSetup?: {
+    read(setupId: string): Promise<IntegrationSetup | Error>;
+    submit(input: {
+      setupId: string;
+      template: string;
+      values: Record<string, string>;
+    }): Promise<{ authorizationUrl?: string } | Error>;
+    cancel(setupId: string): Promise<void | Error>;
+  };
   getWorkspaceStatus?(): Promise<
     ControlPlaneWorkspaceStatus | Error | undefined
   >;

```

```source-diff:setup-web-host:apps/web-app/src/WebHost.ts
diff --git a/apps/web-app/src/WebHost.ts b/apps/web-app/src/WebHost.ts
index d137284..d144fed 100644
--- a/apps/web-app/src/WebHost.ts
+++ b/apps/web-app/src/WebHost.ts
@@ -66,6 +66,30 @@ export class WebHost implements HostApi {
   // Owns browser authentication for this host.
   private readonly authClient = createAuthClient();
 
+  readonly integrationSetup: NonNullable<HostApi["integrationSetup"]> = {
+    read: async (setupId) =>
+      await this.controlPlane.integrations
+        .setup({ setupId })
+        .catch(
+          (cause) =>
+            new WebHostError({ operation: "read connection setup", cause }),
+        ),
+    submit: async (input) =>
+      await this.controlPlane.integrations
+        .submitSetup(input)
+        .catch(
+          (cause) =>
+            new WebHostError({ operation: "create the connection", cause }),
+        ),
+    cancel: async (setupId) =>
+      await this.controlPlane.integrations
+        .cancelSetup({ setupId })
+        .catch(
+          (cause) =>
+            new WebHostError({ operation: "cancel connection setup", cause }),
+        ),
+  };
+
   async getAuthSession() {
     const compatible = await checkControlPlaneCompatibility(
       this.controlPlane,
@@ -162,6 +186,17 @@ export class WebHost implements HostApi {
         operation: "start a connection without a workspace",
       });
     }
+    // Reserve the tab during the click, before the RPC consumes user activation.
+    const setupPage =
+      input.request.kind === "control-plane"
+        ? window.open("about:blank", "_blank")
+        : undefined;
+    // oxlint-disable-next-line unicorn/no-null -- The DOM requires null to detach the setup tab's opener.
+    if (setupPage !== undefined && setupPage !== null) setupPage.opener = null;
+    if (setupPage === null)
+      return new WebHostError({
+        operation: "open setup (allow pop-ups and retry)",
+      });
     const started = await this.haloClient.thread
       .startConnection({
         ...input,
@@ -177,10 +212,18 @@ export class WebHost implements HostApi {
         (cause) =>
           new WebHostError({ operation: "start the connection", cause }),
       );
-    if (started instanceof Error) return started;
+    if (started instanceof Error) {
+      setupPage?.close();
+      return started;
+    }
     if (started.status === "authorization-required") {
+      if (input.request.kind === "control-plane") {
+        setupPage?.location.replace(started.authorizationUrl);
+        return started;
+      }
       window.location.assign(started.authorizationUrl);
     }
+    setupPage?.close();
     return started;
   }
 

```

```source-diff:setup-desktop:apps/electron/src/main/api/registerDesktopApi.ts
diff --git a/apps/electron/src/main/api/registerDesktopApi.ts b/apps/electron/src/main/api/registerDesktopApi.ts
index 625cb61..e8d26d5 100644
--- a/apps/electron/src/main/api/registerDesktopApi.ts
+++ b/apps/electron/src/main/api/registerDesktopApi.ts
@@ -130,6 +130,34 @@ async function connectIntegration(args: {
     });
   }
 
+  if (args.request.request.kind === "control-plane") {
+    const client = createWorkspaceClient(connection);
+    const started = await client.thread
+      .startConnection({
+        ...args.request,
+        completion: { kind: "server-redirect", redirectUri: "" },
+      })
+      .catch(
+        (cause) =>
+          new DesktopOperationError({
+            operation: "start the connection",
+            cause,
+          }),
+      );
+    if (started instanceof Error) return started;
+    if (started.status === "connected") return started;
+    const opened = await openExternalUrl(started.authorizationUrl);
+    if (opened instanceof Error) {
+      await cancelPendingConnection({
+        client,
+        sessionId: args.request.sessionId,
+        connectionId: started.connectionId,
+      });
+      return opened;
+    }
+    return started;
+  }
+
   const callback = await listenForLoopbackCallback({
     timeoutMs: oauthCallbackTimeoutMs,
   });

```

```source-diff:remote-connections:packages/workspace-server/src/agent/runtime/ConnectionService.ts
diff --git a/packages/workspace-server/src/agent/runtime/ConnectionService.ts b/packages/workspace-server/src/agent/runtime/ConnectionService.ts
index 9c1a185..7417492 100644
--- a/packages/workspace-server/src/agent/runtime/ConnectionService.ts
+++ b/packages/workspace-server/src/agent/runtime/ConnectionService.ts
@@ -22,6 +22,8 @@ export class OAuthStateNotFoundError extends errore.createTaggedError({
 }) {}
 
 type PendingConnection = {
+  remote?: boolean;
+  expiresAt?: number;
   connectionId: string;
   completion: OAuthCompletion;
   expires: ReturnType<typeof setTimeout>;
@@ -53,12 +55,34 @@ type OAuthRuntime = {
   cancelOAuth(state: string): Promise<Error | undefined>;
 };
 
+export type RemoteConnectionBackend = {
+  catalog(): Promise<Error | { integration: string; name: string }[]>;
+  startSetup(input: {
+    integration: string;
+    connectionName?: string;
+  }): Promise<Error | { setupId: string; setupUrl: string }>;
+  setup(input: { setupId: string }): Promise<
+    | Error
+    | {
+        status:
+          | "awaiting_credentials"
+          | "authorizing"
+          | "ready"
+          | "cancelled"
+          | "expired"
+          | "failed";
+      }
+  >;
+  cancelSetup(input: { setupId: string }): Promise<Error | undefined>;
+};
+
 export type OAuthCompletionTarget = Pick<
   PendingConnection,
   "completion" | "sessionId"
 >;
 
 export class ConnectionService {
+  private closed = false;
   private readonly pendingConnections = new Map<string, PendingConnection>();
   private readonly connectionIdsByState = new Map<string, string>();
   private readonly connectionStatesBySession = new Map<
@@ -66,9 +90,13 @@ export class ConnectionService {
     HaloConnectionState[]
   >();
 
-  constructor(private readonly runtime: OAuthRuntime) {}
+  constructor(
+    private readonly runtime: OAuthRuntime,
+    private readonly remote?: RemoteConnectionBackend,
+  ) {}
 
   close() {
+    this.closed = true;
     for (const pending of this.pendingConnections.values()) {
       clearTimeout(pending.expires);
     }
@@ -93,6 +121,8 @@ export class ConnectionService {
   async startConnection(
     input: StartConnectionInput,
   ): Promise<ConnectionStarted | Error> {
+    if (input.request.kind === "control-plane")
+      return await this.startRemote(input);
     const started = await this.runtime.startOAuth({
       ...input.request,
       completion: input.completion,
@@ -190,13 +220,16 @@ export class ConnectionService {
     if (pending.sessionId !== input.sessionId) {
       return new ConnectionSessionMismatchError({ sessionId: input.sessionId });
     }
+    const cancelled = pending.remote
+      ? await this.remote?.cancelSetup({ setupId: pending.state })
+      : await this.runtime.cancelOAuth(pending.state);
+    if (cancelled instanceof Error) return cancelled;
+    if (this.pendingConnections.get(input.connectionId) !== pending) return;
     this.takeConnection(input.connectionId);
-    const cancelled = await this.runtime.cancelOAuth(pending.state);
     const notified = await this.publishEvent(
       pending,
       this.connectionEvent(pending, "cancelled"),
     );
-    if (cancelled instanceof Error) return cancelled;
     return notified;
   }
 
@@ -212,6 +245,101 @@ export class ConnectionService {
     return notified;
   }
 
+  private async startRemote(
+    input: StartConnectionInput,
+  ): Promise<ConnectionStarted | Error> {
+    if (this.remote === undefined || this.closed)
+      return new OAuthStateNotFoundError();
+    const started = await this.remote.startSetup({
+      integration: input.request.integration,
+      connectionName: input.request.connectionName,
+    });
+    if (started instanceof Error) return started;
+    if (this.closed) {
+      const cancelled = await this.remote.cancelSetup({
+        setupId: started.setupId,
+      });
+      if (cancelled instanceof Error) return cancelled;
+      return new OAuthStateNotFoundError();
+    }
+    const connectionId = randomUUID();
+    const expiresAt = Date.now() + OAUTH2_SESSION_TTL_MS;
+    const pending: PendingConnection = {
+      ...input,
+      connectionId,
+      state: started.setupId,
+      remote: true,
+      expiresAt,
+      expires: setTimeout(() => void this.pollRemote(connectionId), 1_000),
+    };
+    this.pendingConnections.set(connectionId, pending);
+    const wasConnected = this.statesForSession(input.sessionId).some(
+      (state) =>
+        connectionRequestKey(state.request) ===
+          connectionRequestKey(input.request) && state.status === "connected",
+    );
+    const notified = await this.publishEvent(pending, {
+      type: "halo.connection",
+      connectionId,
+      request: input.request,
+      status: "connecting",
+      expiresAt,
+      wasConnected,
+    });
+    if (notified instanceof Error) return notified;
+    return {
+      status: "authorization-required",
+      authorizationUrl: started.setupUrl,
+      connectionId,
+      expiresAt,
+      wasConnected,
+    };
+  }
+
+  private async pollRemote(connectionId: string) {
+    const pending = this.pendingConnections.get(connectionId);
+    if (pending === undefined || this.remote === undefined) return;
+    const setup = await this.remote.setup({ setupId: pending.state });
+    if (this.pendingConnections.get(connectionId) !== pending) return;
+    if (
+      pending.expiresAt !== undefined &&
+      Date.now() >= pending.expiresAt &&
+      (setup instanceof Error || setup.status !== "ready")
+    ) {
+      this.takeConnection(connectionId);
+      const notified = await this.publishEvent(
+        pending,
+        this.connectionEvent(pending, "expired"),
+      );
+      if (notified instanceof Error)
+        console.warn("Connection expiry notification failed:", notified);
+      return;
+    }
+    if (setup instanceof Error)
+      console.warn("Connection setup lookup failed:", setup);
+    if (
+      setup instanceof Error ||
+      setup.status === "awaiting_credentials" ||
+      setup.status === "authorizing"
+    ) {
+      pending.expires = setTimeout(
+        () => void this.pollRemote(connectionId),
+        2_000,
+      );
+      return;
+    }
+    this.takeConnection(connectionId);
+    const notified = await this.publishEvent(
+      pending,
+      this.connectionEvent(
+        pending,
+        setup.status === "ready" ? "connected" : setup.status,
+      ),
+    );
+    if (notified instanceof Error)
+      console.warn("Connection setup notification failed:", notified);
+  }
+
   private takeConnectionByState(state: string) {
     const connectionId = this.connectionIdsByState.get(state);
     if (connectionId === undefined) return undefined;
@@ -229,7 +357,7 @@ export class ConnectionService {
 
   private connectionEvent(
     pending: PendingConnection,
-    status: "connected" | "cancelled" | "expired",
+    status: "connected" | "cancelled" | "expired" | "failed",
   ): HaloConnectionEvent {
     return {
       type: "halo.connection",

```

```source-diff:remote-runtime:packages/workspace-server/src/agent/runtime/ToolRuntime.ts
diff --git a/packages/workspace-server/src/agent/runtime/ToolRuntime.ts b/packages/workspace-server/src/agent/runtime/ToolRuntime.ts
index efb913a..6f544f8 100644
--- a/packages/workspace-server/src/agent/runtime/ToolRuntime.ts
+++ b/packages/workspace-server/src/agent/runtime/ToolRuntime.ts
@@ -1,4 +1,5 @@
 import { AsyncLocalStorage } from "node:async_hooks";
+import type { RemoteConnectionBackend } from "./ConnectionService.js";
 import { randomUUID } from "node:crypto";
 import { Stream } from "@get-halo/shared/Stream";
 import * as Cause from "effect/Cause";
@@ -368,6 +369,7 @@ function toExecutorSchema(schema: TObject) {
 }
 
 type ToolRuntimeOptions = {
+  remoteConnections?: RemoteConnectionBackend;
   database: DatabaseClient;
   workspaceRoot: string;
   userId: string;
@@ -405,6 +407,7 @@ export class ToolRuntime {
   private readonly authority: AgentAuthority;
   private readonly context: Pick<HaloToolContext, "workspaceRoot" | "userId">;
   private readonly connectionRequests: ReadonlyMap<string, ConnectionRequest>;
+  private readonly remoteConnections: boolean;
   private readonly integrationNames: ReadonlyMap<string, string>;
   private readonly googleWebOAuthClientSlug: OAuthClientSlug | undefined;
 
@@ -417,6 +420,7 @@ export class ToolRuntime {
     authority: AgentAuthority;
     context: Pick<HaloToolContext, "workspaceRoot" | "userId">;
     connectionRequests: ReadonlyMap<string, ConnectionRequest>;
+    remoteConnections: boolean;
     integrationNames: ReadonlyMap<string, string>;
     googleWebOAuthClientSlug: OAuthClientSlug | undefined;
   }) {
@@ -428,6 +432,7 @@ export class ToolRuntime {
     this.authority = input.authority;
     this.context = input.context;
     this.connectionRequests = input.connectionRequests;
+    this.remoteConnections = input.remoteConnections;
     this.integrationNames = input.integrationNames;
     this.googleWebOAuthClientSlug = input.googleWebOAuthClientSlug;
   }
@@ -488,6 +493,11 @@ export class ToolRuntime {
       "Execute JavaScript. tools and console are in scope.",
       'Return the value you need next, for example `return await tools.search({ query: "send email" })`, `return await tools.files.read({ path: "notes.md" })`, or `return await tools[path](args)`. Without return, exec reports (no result), even when a tool failed.',
       "Runtime tools do not throw for expected failures. They return { ok: true, data } or { ok: false, error }. Check result.ok.",
+      ...(this.remoteConnections
+        ? [
+            `Request account setup with tools.halo.showConnectionCard({ integration }). Credentials are entered in the control plane, never in tool arguments. Available remote integration IDs: ${JSON.stringify([...this.connectionRequests.keys()])}.`,
+          ]
+        : []),
     ].join("\n");
     const inventoryStart = executorDescription.indexOf(
       INTEGRATION_INVENTORY_HEADER,
@@ -528,6 +538,7 @@ export class ToolRuntime {
               const connection = connectionInput(
                 context,
                 this.connectionRequests,
+                this.remoteConnections,
               );
               if (connection !== undefined) {
                 connectionRequests.push(connection);
@@ -676,6 +687,10 @@ export class ToolRuntime {
   }
 
   async startOAuth(input: ConnectionRequest & { completion: OAuthCompletion }) {
+    if (input.kind === "control-plane")
+      return new ToolRuntimeError({
+        operation: "start local OAuth for a remote connection",
+      });
     const client =
       input.completion.kind === "client-loopback"
         ? OAuthClientSlug.make(input.client)
@@ -829,12 +844,21 @@ async function createToolRuntime(
       new ToolRuntimeError({ operation: "integration listing", cause }),
   );
   if (integrations instanceof Error) return integrations;
-  const integrationNames = new Map(
-    integrations.map((integration) => [
-      String(integration.slug),
-      integration.name,
-    ]),
-  );
+  const remoteCatalog =
+    input.remoteConnections === undefined
+      ? undefined
+      : await input.remoteConnections.catalog();
+  if (remoteCatalog instanceof Error)
+    console.warn("Remote connection catalog unavailable:", remoteCatalog);
+  const availableRemote = remoteCatalog instanceof Error ? [] : remoteCatalog;
+  const integrationNames = new Map([
+    ...integrations.map(
+      (integration) => [String(integration.slug), integration.name] as const,
+    ),
+    ...(availableRemote ?? []).map(
+      (entry) => [entry.integration, entry.name] as const,
+    ),
+  ]);
 
   const engine = createExecutionEngine({
     executor,
@@ -856,12 +880,24 @@ async function createToolRuntime(
     toolPlugins: input.toolPlugins,
     authority: input.authority,
     context: { workspaceRoot: input.workspaceRoot, userId: input.userId },
-    connectionRequests: integrationsEnabled
-      ? connectionRequestsForClient(
-          oauthClients.desktop,
-          installableGooglePresets,
-        )
-      : new Map(),
+    remoteConnections: input.remoteConnections !== undefined,
+    connectionRequests:
+      availableRemote !== undefined
+        ? new Map(
+            availableRemote.map((entry) => [
+              entry.integration,
+              {
+                kind: "control-plane" as const,
+                integration: entry.integration,
+              },
+            ]),
+          )
+        : integrationsEnabled
+          ? connectionRequestsForClient(
+              oauthClients.desktop,
+              installableGooglePresets,
+            )
+          : new Map(),
     integrationNames,
     googleWebOAuthClientSlug:
       oauthClients.web === undefined
@@ -959,16 +995,23 @@ function sandboxPath(address: string) {
 function connectionInput(
   context: ElicitationContext,
   connectionRequests: ReadonlyMap<string, ConnectionRequest>,
+  remoteConnections: boolean,
 ): ConnectionRequest | undefined {
   if (context.address === showConnectionCardAddress) {
     if (!Value.Check(showConnectionCardInputSchema, context.args)) {
       return undefined;
     }
-    return connectionRequests.get(context.args.integration);
+    // Resolve ownership and catalog membership on the control plane at setup time.
+    // This also supports integrations registered after the workspace started.
+    return remoteConnections
+      ? { kind: "control-plane", integration: context.args.integration }
+      : connectionRequests.get(context.args.integration);
   }
   if (context.address !== oauthStartAddress) return undefined;
   if (!Value.Check(oauthStartInputSchema, context.args)) return undefined;
   const args: Static<typeof oauthStartInputSchema> = context.args;
+  if (remoteConnections)
+    return { kind: "control-plane", integration: args.integration };
   return {
     client: args.client,
     clientOwner: args.clientOwner,

```

```source-diff:remote-request:packages/client/src/ConnectionRequest.ts
diff --git a/packages/client/src/ConnectionRequest.ts b/packages/client/src/ConnectionRequest.ts
index babfdd7..991782f 100644
--- a/packages/client/src/ConnectionRequest.ts
+++ b/packages/client/src/ConnectionRequest.ts
@@ -1,7 +1,8 @@
 import { type Static, Type } from "@sinclair/typebox";
 import { googleIntegrationDisplay } from "./GoogleIntegrationDisplay.js";
 
-export const connectionRequestSchema = Type.Object({
+const legacyConnectionRequestSchema = Type.Object({
+  kind: Type.Optional(Type.Literal("oauth")),
   client: Type.String(),
   clientOwner: Type.Union([Type.Literal("org"), Type.Literal("user")]),
   owner: Type.Union([Type.Literal("org"), Type.Literal("user")]),
@@ -12,9 +13,24 @@ export const connectionRequestSchema = Type.Object({
   newConnection: Type.Optional(Type.Boolean()),
 });
 
+export const connectionRequestSchema = Type.Union([
+  legacyConnectionRequestSchema,
+  Type.Object({
+    kind: Type.Literal("control-plane"),
+    integration: Type.String(),
+    connectionName: Type.Optional(Type.String()),
+  }),
+]);
+
 export type ConnectionRequest = Static<typeof connectionRequestSchema>;
 
 export function connectionRequestKey(request: ConnectionRequest) {
+  if (request.kind === "control-plane")
+    return JSON.stringify([
+      request.kind,
+      request.integration,
+      request.connectionName,
+    ]);
   return JSON.stringify([
     request.client,
     request.clientOwner,

```

```source-diff:remote-state:packages/client/src/sessionState.ts
diff --git a/packages/client/src/sessionState.ts b/packages/client/src/sessionState.ts
index 613d722..701344e 100644
--- a/packages/client/src/sessionState.ts
+++ b/packages/client/src/sessionState.ts
@@ -231,6 +231,7 @@ const haloConnectionEventSchema = Type.Union([
       Type.Literal("connected"),
       Type.Literal("cancelled"),
       Type.Literal("expired"),
+      Type.Literal("failed"),
     ]),
   }),
 ]);

```

```source-diff:remote-state-tests:packages/client/src/sessionState.test.ts
diff --git a/packages/client/src/sessionState.test.ts b/packages/client/src/sessionState.test.ts
index 2ee5db4..748997a 100644
--- a/packages/client/src/sessionState.test.ts
+++ b/packages/client/src/sessionState.test.ts
@@ -371,15 +371,17 @@ test("keeps run outcomes without allowing late updates to replace a newer run",
   expect(aborted.activeRun).toBeUndefined();
 });
 
-test("restores connection progress from session state", () => {
-  const request = {
+test.each([
+  {
     client: "first-party:google",
     clientOwner: "org" as const,
     owner: "user" as const,
     connectionName: "default",
     integration: "google_drive",
     template: "googleOAuth2",
-  };
+  },
+  { kind: "control-plane" as const, integration: "google_drive" },
+])("restores connection progress from session state (%j)", (request) => {
   let snapshot = applySessionEvent(emptySessionSnapshot(), {
     type: "halo.connection",
     connectionId: "connection-1",

```

```source-diff:remote-card:packages/web/src/main/agent/ExecutorConnectionCard.tsx
diff --git a/packages/web/src/main/agent/ExecutorConnectionCard.tsx b/packages/web/src/main/agent/ExecutorConnectionCard.tsx
index 4354b89..2170588 100644
--- a/packages/web/src/main/agent/ExecutorConnectionCard.tsx
+++ b/packages/web/src/main/agent/ExecutorConnectionCard.tsx
@@ -148,18 +148,21 @@ export function ExecutorConnectionCard({
     >
       <Flex column gap={1} p={6}>
         <Flex row gap={4} alignItems="center">
-          <LogoImage
-            src={display === undefined ? brand.logoUrl : display.icon}
-            size="xl"
-          />
+          {display !== undefined && <LogoImage src={display.icon} size="xl" />}
           <Text size="md" fontWeight={600} style={{ flex: 1, minWidth: 0 }}>
             {label}
           </Text>
           {status === "idle" ? (
             <Button
               variant="primary"
-              variantColor={brand.buttonColor}
-              style={{ color: brand.buttonForeground }}
+              variantColor={
+                display === undefined ? undefined : brand.buttonColor
+              }
+              style={
+                display === undefined
+                  ? undefined
+                  : { color: brand.buttonForeground }
+              }
               className={brandButtonClassName}
               isDisabled={!canConnect}
               onClick={() => connect.mutate()}
@@ -227,6 +230,7 @@ const connectionStatusColor = {
   connected: colors.green[11],
   cancelled: colors.orange[11],
   expired: colors.red[11],
+  failed: colors.red[11],
 } as const;
 
 const connectionStatusCopy = {
@@ -234,6 +238,7 @@ const connectionStatusCopy = {
   connecting: "Opened in your browser",
   cancelled: "Cancelled",
   expired: "Expired",
+  failed: "Connection failed",
 } as const;
 
 function ConnectionOverflowMenu({

```

```source-diff:remote-card-state:packages/web/src/main/agent/ConnectionState.ts
diff --git a/packages/web/src/main/agent/ConnectionState.ts b/packages/web/src/main/agent/ConnectionState.ts
index 9f62210..cc19834 100644
--- a/packages/web/src/main/agent/ConnectionState.ts
+++ b/packages/web/src/main/agent/ConnectionState.ts
@@ -6,7 +6,7 @@ import {
 } from "@get-halo/client";
 
 export type ConnectionState =
-  | { status: "idle" | "connected" | "cancelled" | "expired" }
+  | { status: "idle" | "connected" | "cancelled" | "expired" | "failed" }
   | { status: "starting"; wasConnected: boolean }
   | {
       status: "connecting";

```

```source-diff:remote-server:packages/workspace-server/src/server/WorkspaceServer.ts
diff --git a/packages/workspace-server/src/server/WorkspaceServer.ts b/packages/workspace-server/src/server/WorkspaceServer.ts
index f302c21..fe87545 100644
--- a/packages/workspace-server/src/server/WorkspaceServer.ts
+++ b/packages/workspace-server/src/server/WorkspaceServer.ts
@@ -67,6 +67,7 @@ export type WorkspaceServerConfig = {
 };
 
 export type WorkspaceServerHost = {
+  remoteConnections?: import("../agent/runtime/ConnectionService.js").RemoteConnectionBackend;
   reportWorkIdle?: (
     idle: boolean,
     signal: AbortSignal,
@@ -250,6 +251,7 @@ export class WorkspaceServer {
     const [initialized, toolRuntime] = await Promise.all([
       workspace.initialize(),
       ToolRuntime.create({
+        remoteConnections: host.remoteConnections,
         database,
         workspaceRoot,
         userId: config.ownerUserId,
@@ -297,7 +299,10 @@ export class WorkspaceServer {
     if (initialized instanceof Error) return initialized;
     if (toolRuntime instanceof Error) return toolRuntime;
 
-    const connectionService = new ConnectionService(toolRuntime);
+    const connectionService = new ConnectionService(
+      toolRuntime,
+      host.remoteConnections,
+    );
     cleanup.defer(() => connectionService.close());
     const extensions = new ExtensionHost({
       workspaceRoot,

```

```source-diff:remote-main:apps/workspace-server/src/main.ts
diff --git a/apps/workspace-server/src/main.ts b/apps/workspace-server/src/main.ts
index 615d952..dbb671d 100644
--- a/apps/workspace-server/src/main.ts
+++ b/apps/workspace-server/src/main.ts
@@ -20,6 +20,12 @@ import {
 } from "@get-halo/workspace-server";
 import { createOpenAILLMApi } from "@get-halo/workspace-server/llm";
 import * as errore from "errore";
+import { createORPCClient } from "@orpc/client";
+import { RPCLink } from "@orpc/client/fetch";
+import {
+  controlPlaneProtocolVersion,
+  type ControlPlaneClient,
+} from "@get-halo/shared/controlPlaneContract";
 
 class WorkspaceServerStartupError extends errore.createTaggedError({
   name: "WorkspaceServerStartupError",
@@ -93,6 +99,51 @@ async function run() {
       oauthTestOrigin: applicationConfig.oauthTestOrigin,
     },
     host: {
+      remoteConnections:
+        applicationConfig.server.runtime === undefined
+          ? undefined
+          : (() => {
+              const runtime = applicationConfig.server.runtime;
+              const client = createORPCClient<ControlPlaneClient>(
+                new RPCLink({
+                  origin: runtime.origin,
+                  url: "/rpc",
+                  headers: {
+                    authorization: `Bearer ${runtime.token}`,
+                    "x-halo-protocol-version": String(
+                      controlPlaneProtocolVersion,
+                    ),
+                  },
+                }),
+              );
+              const failed = (cause: unknown) =>
+                new WorkspaceServerStartupError({
+                  detail: "control-plane connection setup",
+                  cause,
+                });
+              return {
+                catalog: async () =>
+                  await client.integrations
+                    .catalog(undefined, { signal: AbortSignal.timeout(10_000) })
+                    .catch(failed),
+                startSetup: async (input: {
+                  integration: string;
+                  connectionName?: string;
+                }) =>
+                  await client.integrations
+                    .startSetup(input, { signal: AbortSignal.timeout(10_000) })
+                    .catch(failed),
+                setup: async (input: { setupId: string }) =>
+                  await client.integrations
+                    .setup(input, { signal: AbortSignal.timeout(10_000) })
+                    .catch(failed),
+                cancelSetup: async (input: { setupId: string }) =>
+                  await client.integrations
+                    .cancelSetup(input, { signal: AbortSignal.timeout(10_000) })
+                    .then(() => undefined)
+                    .catch(failed),
+              };
+            })(),
       llmApi,
       reportWorkIdle:
         applicationConfig.server.runtime === undefined

```

```source-diff:remote-tests:packages/workspace-server/test/workspace.test.ts
diff --git a/packages/workspace-server/test/workspace.test.ts b/packages/workspace-server/test/workspace.test.ts
index 31722bb..7af7189 100644
--- a/packages/workspace-server/test/workspace.test.ts
+++ b/packages/workspace-server/test/workspace.test.ts
@@ -2250,6 +2250,80 @@ serverTest(
   },
 );
 
+serverTest(
+  "shows a remote setup card without per-action approval or a startup catalog",
+  async ({ createServer, llm }) => {
+    const server = createServer({
+      remoteConnections: {
+        catalog: async () => new Error("Control plane temporarily offline"),
+        startSetup: async ({ integration }) => {
+          expect(integration).toBe("new_mcp");
+          return {
+            setupId: "setup",
+            setupUrl: "https://halo.example/integrations/setup/setup",
+          };
+        },
+        setup: async () => ({ status: "awaiting_credentials" }),
+        cancelSetup: async () => undefined,
+      },
+    });
+    await server.start();
+    const session = await server.rpc.thread.new();
+    const prompting = server.promptAndWait({
+      ...session,
+      text: "Connect the new MCP server",
+    });
+    await llm.respond(
+      m.tool.start("exec", {
+        id: "remote-connection",
+        arguments: {
+          js: `return await Promise.allSettled([
+            tools.halo.showConnectionCard({ integration: "new_mcp" }),
+            tools.executor.coreTools.oauth.start({ client: "google", clientOwner: "org", owner: "user", name: "personal", integration: "google_gmail", template: "googleOAuth2" })
+          ]);`,
+        },
+      }),
+    );
+    await llm.respond(m.assistant("Use the connection card to connect."));
+    await prompting;
+    const executions = sessionToolExecutions(
+      await server.rpc.thread.snapshot(session),
+    );
+    expect(executions).toHaveLength(1);
+    const execution = executions[0]!;
+    assert(execution.type === "exec");
+    expect(execution.approvals).toEqual([]);
+    const request = { kind: "control-plane" as const, integration: "new_mcp" };
+    expect(execution.result?.details).toMatchObject({
+      connectionRequests: expect.arrayContaining([
+        request,
+        { kind: "control-plane", integration: "google_gmail" },
+      ]),
+    });
+    const started = await server.rpc.thread.startConnection({
+      ...session,
+      request,
+      completion: {
+        kind: "server-redirect",
+        redirectUri: "https://halo.example/unused",
+      },
+    });
+    expect(started).toMatchObject({
+      status: "authorization-required",
+      authorizationUrl: "https://halo.example/integrations/setup/setup",
+    });
+    if (started.status !== "authorization-required")
+      throw new Error("Missing setup");
+    await server.rpc.thread.cancelConnection({
+      ...session,
+      connectionId: started.connectionId,
+    });
+    expect(
+      (await server.rpc.thread.snapshot(session)).connections,
+    ).toMatchObject([{ request, status: "cancelled" }]);
+  },
+);
+
 serverTest(
   "finishes approval requests and retries only after a thread response",
   async ({ server, llm }) => {

```

```source-diff:remote-oauth-tests:packages/workspace-server/test/oauth.test.ts
diff --git a/packages/workspace-server/test/oauth.test.ts b/packages/workspace-server/test/oauth.test.ts
index dd91af1..b35722f 100644
--- a/packages/workspace-server/test/oauth.test.ts
+++ b/packages/workspace-server/test/oauth.test.ts
@@ -7,7 +7,7 @@ import type {
   OAuthCompletion,
   HaloConnectionEvent,
 } from "@get-halo/client";
-import { expect, test } from "vitest";
+import { expect, test, vi } from "vitest";
 import { ConnectionService } from "../src/agent/runtime/ConnectionService.js";
 import { handleOAuthCallback } from "../src/server/oauth.js";
 
@@ -20,6 +20,98 @@ const request: ConnectionRequest = {
   template: "oauth2",
 };
 
+test("remote setup publishes ready once and enforces cancellation ownership", async ({
+  onTestFinished,
+}) => {
+  vi.useFakeTimers();
+  onTestFinished(() => {
+    vi.useRealTimers();
+  });
+  const events: HaloConnectionEvent[] = [];
+  let status: "authorizing" | "ready" = "authorizing";
+  let cancellations = 0;
+  const connections = new ConnectionService(new FakeOAuthRuntime(), {
+    catalog: async () => [],
+    startSetup: async () => ({
+      setupId: "setup",
+      setupUrl: "https://halo.example/integrations/setup/setup",
+    }),
+    setup: async () => ({ status }),
+    cancelSetup: async () => {
+      cancellations++;
+      return new Error("OAuth callback is completing");
+    },
+  });
+  onTestFinished(() => connections.close());
+  const started = await connections.startConnection({
+    sessionId: "owner",
+    request: { kind: "control-plane", integration: "example" },
+    completion: { kind: "server-redirect", redirectUri: "" },
+    onEvent: async (event) => {
+      events.push(event);
+    },
+  });
+  expect(started).toMatchObject({
+    status: "authorization-required",
+    authorizationUrl: "https://halo.example/integrations/setup/setup",
+  });
+  if (started instanceof Error || started.status !== "authorization-required")
+    throw new Error("Setup did not start");
+  expect(
+    await connections.cancelConnection({
+      sessionId: "other",
+      connectionId: started.connectionId,
+    }),
+  ).toBeInstanceOf(Error);
+  expect(cancellations).toBe(0);
+  expect(
+    await connections.cancelConnection({
+      sessionId: "owner",
+      connectionId: started.connectionId,
+    }),
+  ).toBeInstanceOf(Error);
+  expect(cancellations).toBe(1);
+  expect(events.map((event) => event.status)).toEqual(["connecting"]);
+  await vi.advanceTimersByTimeAsync(1_000);
+  status = "ready";
+  await vi.advanceTimersByTimeAsync(2_000);
+  await vi.advanceTimersByTimeAsync(10_000);
+  expect(events.map((event) => event.status)).toEqual([
+    "connecting",
+    "connected",
+  ]);
+  connections.close();
+  expect(vi.getTimerCount()).toBe(0);
+  vi.useRealTimers();
+});
+
+test.each(["cancelled", "expired", "failed"] as const)(
+  "remote %s setup terminates polling",
+  async (status) => {
+    vi.useFakeTimers();
+    const connections = new ConnectionService(new FakeOAuthRuntime(), {
+      catalog: async () => [],
+      startSetup: async () => ({
+        setupId: "setup",
+        setupUrl: "https://halo.example/setup",
+      }),
+      setup: async () => ({ status }),
+      cancelSetup: async () => undefined,
+    });
+    await connections.startConnection({
+      sessionId: "owner",
+      request: { kind: "control-plane", integration: "example" },
+      completion: { kind: "server-redirect", redirectUri: "" },
+      onEvent: async () => undefined,
+    });
+    await vi.advanceTimersByTimeAsync(1_000);
+    expect(connections.statesForSession("owner")).toMatchObject([{ status }]);
+    expect(vi.getTimerCount()).toBe(0);
+    connections.close();
+    vi.useRealTimers();
+  },
+);
+
 class FakeOAuthRuntime {
   readonly state = "test-oauth-state";
   completionKind: OAuthCompletion["kind"] | undefined;

```

```source-diff:remote-fixture:packages/workspace-server/test/TestServer.ts
diff --git a/packages/workspace-server/test/TestServer.ts b/packages/workspace-server/test/TestServer.ts
index f1c5a9f..0afbc4c 100644
--- a/packages/workspace-server/test/TestServer.ts
+++ b/packages/workspace-server/test/TestServer.ts
@@ -26,6 +26,7 @@ export class TestServer {
   private readonly testApiEnabled: boolean;
   private readonly traceWorkspaceId: WorkspaceServerOptions["config"]["traceWorkspaceId"];
   private readonly traceUploader: WorkspaceServerOptions["host"]["traceUploader"];
+  private readonly remoteConnections: WorkspaceServerOptions["host"]["remoteConnections"];
   private readonly gateway: WorkspaceServerOptions["config"]["gateway"];
 
   constructor(ctx: {
@@ -35,6 +36,7 @@ export class TestServer {
     agentCapabilities?: WorkspaceServerOptions["host"]["agentCapabilities"];
     testApiEnabled?: boolean;
     traceUploader?: WorkspaceServerOptions["host"]["traceUploader"];
+    remoteConnections?: WorkspaceServerOptions["host"]["remoteConnections"];
     traceWorkspaceId?: string;
     gateway?: WorkspaceServerOptions["config"]["gateway"];
   }) {
@@ -53,6 +55,7 @@ export class TestServer {
     this.agentCapabilities = ctx.agentCapabilities;
     this.testApiEnabled = testApiEnabled === undefined ? false : testApiEnabled;
     this.traceUploader = traceUploader;
+    this.remoteConnections = ctx.remoteConnections;
     this.traceWorkspaceId = traceWorkspaceId;
     this.gateway = gateway;
   }
@@ -113,6 +116,7 @@ export class TestServer {
       },
       host: {
         llmApi: this.llmApi,
+        remoteConnections: this.remoteConnections,
         agentCapabilities: this.agentCapabilities,
         traceUploader: this.traceUploader,
         logger: this.artifacts.logger,

```

```source-diff:remote-server-fixture:packages/workspace-server/test/serverTest.ts
diff --git a/packages/workspace-server/test/serverTest.ts b/packages/workspace-server/test/serverTest.ts
index d517246..d82a443 100644
--- a/packages/workspace-server/test/serverTest.ts
+++ b/packages/workspace-server/test/serverTest.ts
@@ -15,6 +15,7 @@ type ServerOptions = {
   workspaceRoot?: string;
   testApiEnabled?: boolean;
   traceUploader?: WorkspaceServerOptions["host"]["traceUploader"];
+  remoteConnections?: WorkspaceServerOptions["host"]["remoteConnections"];
   traceWorkspaceId?: string;
 };
 
@@ -58,6 +59,7 @@ export const serverTest = baseTest.extend<{
         llmApi: createOpenAILLMApi(llm.configuration),
         agentCapabilities: options.agentCapabilities,
         traceUploader: options.traceUploader,
+        remoteConnections: options.remoteConnections,
         traceWorkspaceId: options.traceWorkspaceId,
         workspaceRoot:
           options.workspaceRoot === undefined

```

```source-diff:remote-deps:apps/workspace-server/package.json
diff --git a/apps/workspace-server/package.json b/apps/workspace-server/package.json
index d899240..ba7e0ad 100644
--- a/apps/workspace-server/package.json
+++ b/apps/workspace-server/package.json
@@ -17,6 +17,7 @@
     "@get-halo/logger": "workspace:*",
     "@get-halo/shared": "workspace:*",
     "@get-halo/workspace-server": "workspace:*",
+    "@orpc/client": "2.0.0-beta.29",
     "errore": "^0.14.1",
     "google-auth-library": "^11.0.2",
     "tsx": "^4.23.13"

```

## Final connection contract patch

```source-diff:phase7-contract:packages/client/src/contract.ts
diff --git a/packages/client/src/contract.ts b/packages/client/src/contract.ts
index 00182d6f..a253a9fc 100644
--- a/packages/client/src/contract.ts
+++ b/packages/client/src/contract.ts
@@ -27,7 +27,7 @@ import type {
   WorkspaceTreeEvent,
 } from "./rpc.js";
 
-export const haloProtocolVersion = 24 as const;
+export const haloProtocolVersion = 25 as const;
 export const haloSupportedProtocols = [haloProtocolVersion];
 
 export const RequestRejectedError = error("BAD_REQUEST", {
@@ -49,10 +49,6 @@ export type ConnectionStarted =
       wasConnected: boolean;
     };
 
-export type OAuthCompletion =
-  | { kind: "client-loopback"; redirectUri: string }
-  | { kind: "server-redirect"; redirectUri: string };
-
 export type ExtensionSummary = {
   id: string;
   url: string;
@@ -200,11 +196,9 @@ export const contract = publicProcedure.router({
         type<{
           sessionId: string;
           request: ConnectionRequest;
-          completion: OAuthCompletion;
         }>(),
       )
       .output(type<ConnectionStarted>()),
-    completeOAuth: oc.input(type<{ state: string; code: string }>()),
     cancelConnection:
       oc.input(type<{ sessionId: string; connectionId: string }>()),
     respondToToolApproval:
```
