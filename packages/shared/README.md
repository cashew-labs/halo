# Halo session protocol

`@get-halo/shared/sessionState` defines the session format used by Halo's RPC API and renderer. These types and the reducer are the foundation for a future agent SDK; they do not import Pi types. This package is not a separately published agent SDK yet.

## Reading a conversation

`sessions.snapshot({ sessionId })` returns a `SessionSnapshot`:

- `entries`: committed `HaloEntry` objects in conversation order, with stable entry IDs.
- `activeRun`: the run ID, current unfinished assistant message, and active or staged tool executions. It is absent when the session is idle.
- `lastRun`: the previous run's ID, outcome, and optional error. Starting a new run does not erase this outcome.
- `fault`: a session-level failure, separate from an ordinary failed or aborted run.

An entry is either a message or a tool result. A tool-result entry references its originating tool call by `toolCallId`. The originating assistant message contains the call's arguments. Entry IDs and tool-call IDs are different identities.

A partial assistant message belongs to the active run. It is not a committed entry and does not claim a durable entry ID. A later `entry.committed` update supplies the actual entry ID and replaces that partial response.

## Watching a conversation

`sessions.watch({ sessionId })` returns one snapshot item followed by event items. `reduceSessionUpdate` replaces state on a snapshot and applies subsequent updates. It can be used with `stream.project(emptySessionSnapshot(), reduceSessionUpdate)`.

The events describe Halo objects: entries, current assistant messages, tool executions, and run outcomes. They do not expose Pi's text/thinking delta event dialect. Connection-status notifications also travel through the watch; the session reducer leaves those for the connection consumer.

Disconnecting a watch does not stop its run. Reconnecting obtains another snapshot and a new live subscription. Events themselves are ephemeral; there is no cursor-based event-log replay. A full server restart restores saved data but currently aborts unfinished restored operations instead of resuming execution.

## Exec is a distinct execution type

Halo supplies the fixed top-level tools `read`, `write`, `bash`, `edit`, `patch`, and `exec`. The SDK does not configure or register tools. Calls inside `exec` are dynamic: their paths, arguments, and integration identities describe the tools available in that workspace.

`ToolOutput` and `ToolExecution` distinguish `type: "exec"` from ordinary tools. Exec exposes a typed `calls` array alongside its outer result. Each nested call has an ID, parent ID, tool identity, arguments, and status. Consumers do not need to parse Pi tool-result details to discover nested calls.

The same nested-call format is supplied during execution, in snapshots, and in committed results. Full output for each nested call is not currently captured; the outer exec result contains the execution output. A parent result can retain a nested call marked running if execution was interrupted before that nested call finished; it is only active while the parent execution is running.

`sessionToolExecutions(snapshot)` assembles outer executions from committed entries and current run state. Each exec execution contains its nested calls. This is a pure helper; the snapshot does not retain a duplicate index of completed tools. Arguments may be unavailable when an originating message is outside the supplied transcript.

`sessionMessages(snapshot)` selects committed messages. Chat-turn grouping, hiding the outer exec row, tool labels, working indicators, and readable error formatting belong to the renderer.

## Storage boundary

The server's `sessionEvents.ts` module converts Pi entries, snapshots, and events into this protocol. Pi still owns durable session storage through the Turso adapter. Exec's storage details remain internal to that adapter; changing the public format does not require changing the database schema.

The current transcript follows Pi's compaction boundary. Loading earlier pre-compaction entries and publishing a standalone SDK package are separate work.
