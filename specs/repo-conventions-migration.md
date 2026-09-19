# Repository conventions progress

## Chat-configurable hotkeys

Implemented a workspace-owned `HotkeyService` that borrows the server's database. Chat tools and RPC clients share its validation and persistence operations. A per-service queue orders writes and initial subscriptions; clients receive committed snapshots over a reconnecting stream. Each desktop window owns its native keyboard bindings, and the shortcuts menu derives from the same saved state.

Keyboard actions reuse `WorkspacePanes.open` and `close`. Command T creates a fresh draft in a new tab. Custom shortcuts support app actions, workspace files, and extensions, with reserved-key and duplicate checks.

Verification extends the existing workspace-server and Electron consumer tests, covering chat tool invocation, live updates, restart persistence, conflict rejection, and preserved drafts.

The shortcuts popup is a read-only list. Clicking labels, key badges, or popup content does not run actions or dismiss it. Clicking the backdrop or pressing Escape dismisses it. The existing desktop flow covers these interactions.
