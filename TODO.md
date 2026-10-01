# To do

- [ ] Add a custom Vitest reporter for agent runs that streams test progress, reports failures immediately, and ends with a compact summary.
- [ ] Add a persistent graphical session to workspace VMs for headed browser and GUI automation, including a virtual display, software rendering, remote viewing and input, and browser lifecycle management.
- [ ] Reconsider Drizzle for Halo-owned control-plane data once the schema grows or local development standardizes on PostgreSQL; keep Better Auth on its built-in database adapter unless its migration workflow also changes.
- [ ] Remove workspace VM access to the OpenAI API key after inference moves behind the control plane.
- [ ] Reduce the workspace-server container to its required production dependency tree, then preload Docker and the immutable container image into the workspace VM boot image to shorten first-time provisioning.

## Tandem migration (temporary)

Move this section into the PR description when creating the PR, then remove it here. Keep the unrelated backlog above.

- [ ] Migrate Halo to Tandem
  - [x] Add TandemServer to the workspace server
    - [x] Own database lifetime, schema, and relations in DatabaseService
    - [x] Add a Turso tuple-storage adapter
    - [x] Expose native access for remaining SQL consumers
  - [x] Move hotkeys and routines to Tandem
    - [x] Move hotkeys to Tandem and a domain-shaped Turso table
    - [x] Move routines and run history to Tandem
  - [x] Refactor database schemas
    - [x] Rename storage/ to database/
    - [x] Encapsulate each table's Tandem fields and Turso record translation
    - [x] Build the Tandem schema and tuple storage from those definitions
    - [x] Separate haloSchema definitions from Tandem and Turso consumer conversions
  - [x] Move session read/done state to Tandem
    - [x] Expose Tandem operations and disposable transactions through DatabaseService
  - [x] Share schema and storage primitives
    - [x] Make TursoTupleStorage accept schema definitions
    - [x] Validate hotkey, routine, and session flows
  - [x] Wire the Halo web app to TandemClient
    - [x] Add authenticated workspace sync transport
    - [x] Derive the client schema from shared Halo table definitions
    - [x] Use TandemClientProvider and useTandemQuery for frontend state
    - [x] Add workspace-scoped TandemClient initialization, reconnect, and disposal
    - [x] Read hotkeys from TandemClient
    - [x] Remove HotkeyService.watch, its watch RPC, and hotkey forwarding in watchWorkspace
    - [x] Validate hotkey sync across windows, offline deletion, and restarts
  - [x] Consolidate shared schema code and converters into client/database/schema
  - [x] Read routines and run history from TandemClient
    - [x] Remove routine watch forwarding and validate live edits and runs
  - [ ] Remove TanStack Query from the frontend
    - [ ] Phase 1: move stream and UI state out of QueryClient
      - [ ] Move workspace metadata and session summaries to workspace-owned state
      - [ ] Move draft snapshots, submitted titles, and integration connection state to their owners
      - [ ] Preserve state reset on user and workspace changes
      - [ ] Validate reconnect, draft submission, tab titles, and integration connection flows
    - [ ] Phase 2: replace host queries and polling
      - [ ] Add an async-read hook with stale-request cleanup and delayed loading state
      - [ ] Move app-info polling and update actions to host state
      - [ ] Validate polling cleanup, update errors, and compatibility checks
    - [ ] Phase 3: replace filesystem queries
      - [ ] Move path listings, file contents, and previews to shared filesystem state
      - [ ] Preserve autosave synchronization, file-event invalidation, and reconnect refresh
      - [ ] Replace shared file-operation pending state
      - [ ] Validate multi-pane edits, file moves/deletions, and stale responses after navigation
    - [ ] Phase 4: remove remaining mutations and the dependency
      - [ ] Replace remaining mutation pending and error state
      - [ ] Remove QueryClientProvider, cache keys, and the dependency
      - [ ] Run affected checks and Electron session, routine, file, and host flows
  - [ ] Decide Executor storage: direct Tandem adapter or native SQL with synchronized public records
    - [ ] Resolve change-feed ownership if retaining native SQL
  - [ ] Squash migrations introduced by this work into one before creating the PR

### Deferred

- [ ] Move Pi onto Tandem
  - [ ] Adapt session storage and repository operations
  - [ ] Move Pi-derived session summaries to Tandem
  - [ ] Update session search alongside session storage
  - [ ] Remove SessionRegistry's Tandem-to-summary bridge after migrating session summary consumers
- [ ] Move extension storage into the main database
  - [ ] Register extension schemas and create native tables
    - [ ] Authenticate schema registration during extension startup
    - [ ] Assign extension-specific table names and generate table-creation SQL
    - [ ] Persist schemas and reject unsupported changes
    - [ ] Validate registration across restarts and table isolation
  - [ ] Connect extension Tandem storage to the workspace
    - [ ] Add authenticated scan and atomic commit endpoints
    - [ ] Add the SDK storage adapter
    - [ ] Drain in-flight storage work and reject stale tokens during restart
    - [ ] Validate storage conformance, rollback, isolation, and persistence
  - [ ] Switch extensions to workspace-backed storage
    - [ ] Include shared schema APIs in the distributed extension SDK
    - [ ] Update serveExtension, templates, skills, and fixtures to use haloSchema
    - [ ] Define standalone development behavior
    - [ ] Validate live extension edits, browser sync, and restart persistence
