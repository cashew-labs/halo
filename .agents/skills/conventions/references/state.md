# State

The first question is who owns a value. Then decide how consumers observe it and which operations need ordering to change it safely.

## Put mutable state on its owner

Keep mutable runtime state on service instances, not in module globals or hidden singletons. Immutable module-level data is fine.

For a browser host, avoid clients that are shared by every instance:

```ts
const authClient = createAuthClient();
let workspaceClient: WorkspaceClient | undefined;
```

Prefer clients owned by each host instance:

```ts
class WebHost {
  // Tracks this host's connected workspace.
  private workspaceClient: WorkspaceClient | undefined;
  // Owns browser authentication for this host.
  private readonly authClient = createAuthClient();
}
```

Ownership also determines where persistent state belongs. Humans and agents use the same underlying product state. For workspace products, keep it in the chosen workspace filesystem, not a second agent-only store. Local development credentials and artifacts belong with their owning host.

## Derive the views consumers see

Represent consumer-visible mutable state as streams. Methods issue commands; streams publish state. Derive mapped or materialized views instead of keeping separately updated copies. A total derived from events illustrates the difference:

```ts
// Avoid: each write must remember to update both values.
source.append(value);
total += value;

// Prefer: a consumer derives its total from the event stream.
const totals = source.project(0, (sum, value) => sum + value);
```

Subscribe before emitting events; this projection is not a persisted store or a replay of events from before the subscription.

Not every field needs to be a stream. Internal queues, caches, and in-flight operations can remain ordinary private state when consumers do not observe them.

## Order changes without blocking control

Use `SerialQueue` for operations that need ordering, with a queue per state owner rather than hand-written Promise chains or a global server queue. Name a class's single queue `actionQueue`; name multiple queues by purpose, such as `writeQueue` or `reloadQueue`.

Keep public methods semantic, such as `reload()` or `close()`, and put their ordered work inside `actionQueue.run(...)`. Inline the operation unless its implementation is shared; name shared private implementations `*Unqueued`. Already-queued work calls those helpers directly, never a method that enqueues on the same queue: awaiting that nested operation would deadlock.

`SerialQueue.run()` preserves the operation's result or rejection and lets later operations run after a failure. Queue only work that needs ordering. Long-running model calls, tools, and subscriptions must not block the queue needed to cancel or control them.
