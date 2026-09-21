# Repository conventions progress

## Native test fixtures

Repository testing conventions now require Vitest or Playwright's native fixture API for test setup and teardown. File-local fixtures live near the top of their test file and use a fixture-specific extended test name. Fixtures shared by multiple E2Es are consolidated in `test/fixtures.ts`; source-local fixtures and other test helpers use a `*.test.ts` suffix and are explicitly excluded from test discovery.

Package E2Es live under `test/` as `*.spec.ts` and enter through the package's main export. File-level unit tests live beside their source as `<MainExport>.test.ts` and treat that export as a consumer API rather than testing implementation details. This layout applies as tests are added or changed; unrelated legacy tests are not part of the migration. The migration algorithm coverage now uses a file-local `migrationTest` fixture in `src/storage/Migration.test.ts`. Pi's backend conformance coverage lives beside `TursoSessionRepo` and `TursoStorage` and shares the native `piBackendTest` fixture from `src/storage/fixtures.test.ts`. Both fixtures own their temporary files, database connections, and cleanup.

## Chat-configurable hotkeys

Implemented a workspace-owned `HotkeyService` that borrows the server's database. Chat tools and RPC clients share its validation and persistence operations. A per-service queue orders writes and initial subscriptions; clients receive committed snapshots over a reconnecting stream. Each desktop window owns its native keyboard bindings, and the shortcuts menu derives from the same saved state.

Keyboard actions reuse `WorkspacePanes.open` and `close`. Command T creates a fresh draft in a new tab. Custom shortcuts support app actions, workspace files, and extensions, with reserved-key and duplicate checks.

Agent hotkeys store a `runAgent` action with a self-contained prompt. Pressing the binding creates a normal session, opens it in a new tab, and submits the saved instruction through the existing sessions API. The agent can use its normal tools to generate files and perform multi-step work. Saving the binding does not run it, and each invocation starts a fresh conversation. Empty instructions are rejected; creation and prompt failures are shown in the shortcuts dialog. Protocol 17 includes the agent action and shared workspace update stream.

Hidden chat tabs release their transcript streams and reconnect with a fresh snapshot when shown. This retains drafts while preventing inactive tabs from exhausting browser HTTP connections as agent shortcuts create more sessions.

Verification extends the existing workspace-server and Electron consumer tests, covering chat tool invocation, live updates, restart persistence, conflict rejection, and preserved drafts.

Agent-action coverage in those same files checks persisted instructions, chat-driven creation and updates, generated Markdown file contents, fresh sessions, preserved drafts, and recovery after session-creation or prompt failures. Inference is scripted at the provider boundary; file writes use the real agent tool runtime and workspace filesystem.

The renderer consumes one `server.watch` stream for hotkeys, extension snapshots, session summaries, and filesystem changes. Existing owners retain snapshot ordering and buffer their updates; disconnecting aborts and disposes every constituent subscription. This avoids exhausting browser HTTP connections with independent app-wide streams and leaves capacity for agent prompts and cancellation in split panes. The server consumer test covers initial snapshots, hotkey updates, reconnect, and cancellation; the desktop regression covers launching and stopping an agent hotkey with two visible chats.

The shortcuts popup is a read-only list. Clicking labels, key badges, or popup content does not run actions or dismiss it. Clicking the backdrop or pressing Escape dismisses it. The existing desktop flow covers these interactions.
