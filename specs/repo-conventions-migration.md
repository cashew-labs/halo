# Repository conventions progress

## Chat attachments

The sessions prompt API accepts files alongside text. `HaloAgentSession` prepares attachments before submitting the user message: originals are saved under unique workspace `attachments/` paths, text is extracted from documents, and images are normalized into native model image parts. PDFs include extracted text and every rendered page, including image-only scans and vector artwork. File metadata and the original prompt text persist with the message so transcript presentation and session titles do not expose the expanded model context.

The server consumer tests inspect actual inference-provider requests for images, PDF and scanned PDF, Office and OpenDocument files, RTF, EPUB, and text/code exports. They also cover duplicate names, attachment-only messages, restart persistence, invalid files, and size/count limits. Unsupported binary formats are rejected explicitly. Poppler is required for PDF conversion and is already installed in the workspace-server container.

The file-drop overlay uses a translucent surface so the chat stays visible. File drag-over events are captured before they reach the editor, preventing its insertion cursor from appearing. The existing Electron file-drop flow covers dragging over the composer.

The shared chat pane owns pending files and accepts drops anywhere in the pane, file-picker selection, and pasted files. Users can remove individual files, send attachments without text, and open saved originals from transcript links. Failed preparation keeps the draft and file selection. Client message IDs correlate stream acknowledgements with submissions, releasing the composer when the user message is committed while the model continues; late prompt responses cannot clear a newer draft. Electron tests cover the complete paths through the real server and inspect inference requests after reload.

## Draft chat handoff

The draft chat passes its confirmed session snapshot through the app-owned query cache before navigating to the saved session. The new pane uses that snapshot until its subscription receives fresh server state, then removes the temporary handoff data. This keeps the first message and running state visible across the route change. The Electron session-view regression pauses the replacement subscription and checks that the message remains visible without disappearing or duplicating through the handoff.

## Chat-configurable hotkeys

Implemented a workspace-owned `HotkeyService` that borrows the server's database. Chat tools and RPC clients share its validation and persistence operations. A per-service queue orders writes and initial subscriptions; clients receive committed snapshots over a reconnecting stream. Each desktop window owns its native keyboard bindings, and the shortcuts menu derives from the same saved state.

Keyboard actions reuse `WorkspacePanes.open` and `close`. Command T creates a fresh draft in a new tab. Custom shortcuts support app actions, workspace files, and extensions, with reserved-key and duplicate checks.

Agent hotkeys store a `runAgent` action with a self-contained prompt. Pressing the binding creates a normal session, opens it in a new tab, and submits the saved instruction through the existing sessions API. The agent can use its normal tools to generate files and perform multi-step work. Saving the binding does not run it, and each invocation starts a fresh conversation. Empty instructions are rejected; creation and prompt failures are shown in the shortcuts dialog. Protocol 17 includes the agent action and shared workspace update stream.

Hidden chat tabs release their transcript streams and reconnect with a fresh snapshot when shown. This retains drafts while preventing inactive tabs from exhausting browser HTTP connections as agent shortcuts create more sessions.

Verification extends the existing workspace-server and Electron consumer tests, covering chat tool invocation, live updates, restart persistence, conflict rejection, and preserved drafts.

Agent-action coverage in those same files checks persisted instructions, chat-driven creation and updates, generated Markdown file contents, fresh sessions, preserved drafts, and recovery after session-creation or prompt failures. Inference is scripted at the provider boundary; file writes use the real agent tool runtime and workspace filesystem.

The renderer consumes one `server.watch` stream for hotkeys, extension snapshots, session summaries, and filesystem changes. Existing owners retain snapshot ordering and buffer their updates; disconnecting aborts and disposes every constituent subscription. This avoids exhausting browser HTTP connections with independent app-wide streams and leaves capacity for agent prompts and cancellation in split panes. The server consumer test covers initial snapshots, hotkey updates, reconnect, and cancellation; the desktop regression covers launching and stopping an agent hotkey with two visible chats.

The shortcuts popup is a read-only list. Clicking labels, key badges, or popup content does not run actions or dismiss it. Clicking the backdrop or pressing Escape dismisses it. The existing desktop flow covers these interactions.

HEIC and HEIF chat photos use a portable HEVC decoder because the prebuilt image library omits that codec. The workspace consumer tests verify both extensions reach the inference provider as native JPEG image parts.
