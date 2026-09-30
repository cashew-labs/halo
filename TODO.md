# To do

- [ ] Add a custom Vitest reporter for agent runs that streams test progress, reports failures immediately, and ends with a compact summary.
- [ ] Add a persistent graphical session to workspace VMs for headed browser and GUI automation, including a virtual display, software rendering, remote viewing and input, and browser lifecycle management.
- [ ] Reconsider Drizzle for Halo-owned control-plane data once the schema grows or local development standardizes on PostgreSQL; keep Better Auth on its built-in database adapter unless its migration workflow also changes.
- [ ] Remove workspace VM access to the OpenAI API key after inference moves behind the control plane.
- [ ] Reduce the workspace-server container to its required production dependency tree, then preload Docker and the immutable container image into the workspace VM boot image to shorten first-time provisioning.

## Tandem migration (temporary)

Move this section into the PR description when creating the PR, then remove it here. Keep the unrelated backlog above.

- [ ] Migrate Halo to TandemServer
  - [x] Add TandemServer to the workspace server
    - [x] Own database lifetime, schema, and relations in DatabaseService
    - [x] Add a Turso tuple-storage adapter
    - [x] Expose native access for remaining SQL consumers
  - [ ] Move services to Tandem
    - [x] Move hotkeys to Tandem and a domain-shaped Turso table
    - [x] Move routines and run history to Tandem
    - [ ] Move session summaries and read/done state to Tandem
    - [ ] Update session search alongside session storage
    - [ ] Decide Executor storage: direct Tandem adapter or native SQL with synchronized public records
      - [ ] Resolve change-feed ownership if retaining native SQL
  - [ ] Refactor storage schemas after this phase
    - [ ] Encapsulate each table's Tandem fields and Turso record translation
    - [ ] Build the Tandem schema and tuple storage from those definitions
  - [ ] Move extension storage into the main database
  - [ ] Move Pi onto Tandem
    - [ ] Adapt session storage and repository operations
- [ ] Migrate the Halo web app to TandemClient
  - [ ] Add authenticated workspace sync transport
  - [ ] Add workspace-scoped TandemClient initialization, reconnect, and disposal
  - [ ] Replace manual state subscriptions with Tandem queries
    - [ ] Remove HotkeyService.watch, its watch RPC, and hotkey forwarding in watchWorkspace
- [ ] Squash migrations introduced by this work into one before creating the PR
