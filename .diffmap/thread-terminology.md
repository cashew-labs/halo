# Thread terminology

Halo conversations should use thread terminology in prompts, UI, source identifiers, fixtures, and documentation. Serialized names must remain readable by supported clients and existing workspaces.

Use the persisted Halo thread ID in the agent's environment prompt. Rename conversation-local source names, while retaining legacy fields at RPC, database, URL, and saved-state boundaries. Authentication, browser, OS, and JavaScript execution sessions are separate concepts and keep their names.

## Goals and non-goals

Keep existing thread content, automation history, drafts, favorites, links, and sync state readable. Do not migrate storage or rename third-party APIs.

## ✅ Phase 1: Identify the current thread and name conversations in the UI

**Today:** The agent prompt omitted the Halo thread ID and visible labels used sessions.

**Proposed:** Pass the persisted thread metadata ID through the resource loader into `Current thread ID: …`. Use threads in conversation labels and messages.

```tsx
const prompt = haloEnvironmentPrompt({ threadId: stored.metadata.id });
// <env> … Current thread ID: <persisted Halo thread ID> … </env>
```

```callstack
 Thread.attach [[packages/workspace-server/src/agent/Thread.ts#Thread.attach]]
+└── WorkspaceResourceLoader receives stored.metadata.id
+    └── haloEnvironmentPrompt includes Current thread ID [[prompt:new:107]]
```

## ✅ Phase 2: Rename conversation source names

**Today:** Source types, locals, methods, files, and fixtures still use session terminology.

**Proposed:** Rename them to thread terminology and map legacy serialized fields at their boundaries.

```tsx
const { sessionId: threadId } = await client.thread.new();
const snapshot: ThreadSnapshot = await client.thread.snapshot({ sessionId: threadId });
const messages = threadMessages(snapshot);
```

The client exports thread-named types and reducers, the server owns `src/threads`, and web and Electron use thread-named components and fixtures. Host IPC uses `threadId` and maps it to the workspace RPC's legacy `sessionId`. `seedThread` is canonical; `seedSession` remains a gated compatibility alias.

RPC fields, event discriminators, database and sync collection names, saved drafts and favorites, URLs, automation fields, and trace archives retain their existing representations. The schema declaration uses `threadState` while retaining the persisted `sessionState` collection [[schema:new:8-9]].

## Verification

- `pnpm run check-affected`: 52 successful tasks, including typecheck, lint, formatting, and unit tests.
- Workspace server E2Es: 77 passed, including distinct prompt IDs before and after restart.
- Targeted control-plane compatibility tests: 3 passed.
- Packaged Electron build passed. Five focused Electron scenarios passed at the default budget. Two reference scenarios exceeded the default 30-second budget, then passed unchanged with a diagnostic 60-second budget (43.1 and 27.2 seconds). The repository timeout was not changed.
- Inspected the running UI's default, search, reference picker, automation options, removal confirmation, and removed states. Conversation labels use threads.
- Oracle review found no functional blockers. Its stale source-reference findings were corrected.
- `git diff --check` passed during implementation.

## Source patches

```source-diff:prompt:packages/workspace-server/src/agent/workspacePrompt.ts
diff --git a/packages/workspace-server/src/agent/workspacePrompt.ts b/packages/workspace-server/src/agent/workspacePrompt.ts
index 368e691..cba85c6 100644
--- a/packages/workspace-server/src/agent/workspacePrompt.ts
+++ b/packages/workspace-server/src/agent/workspacePrompt.ts
@@ -97,12 +97,14 @@ Do not browse parent directories or other projects for extra context.
 export function haloEnvironmentPrompt(ctx: {
   environment: HaloEnvironment;
   workspaceRoot: string;
+  threadId: string;
 }) {
   const path = ctx.workspaceRoot.replaceAll("\\", "/");
   const homePath = os.homedir().replaceAll("\\", "/");
   const system = `${os.type()} ${os.release()} (${process.platform}, ${os.arch()})`;
   return `<env>
  Working directory and workspace root: ${path}
+ Current thread ID: ${ctx.threadId}
 ${ctx.environment === "cloud" ? ` Unix home: ${homePath}\n` : ""} System: ${system}
  Today's date: ${new Date().toDateString()}
 </env>`;
```

```source-diff:schema:packages/client/src/database/schema/workspaceSchema.ts
diff --git a/packages/client/src/database/schema/workspaceSchema.ts b/packages/client/src/database/schema/workspaceSchema.ts
index b6ef3ebd..6872a46a 100644
--- a/packages/client/src/database/schema/workspaceSchema.ts
+++ b/packages/client/src/database/schema/workspaceSchema.ts
@@ -3 +3 @@ import { hotkeys } from "./hotkeys.js";
-import { sessionState } from "./sessionState.js";
+import { threadState } from "./threadState.js";
@@ -8 +8,2 @@ export const workspaceSchema = haloSchema.schema({
-  sessionState,
+  // Tandem clients persist this collection name in their sync state.
+  sessionState: threadState,
```

## References

- [[packages/workspace-server/src/agent/workspacePrompt.ts]]
- [[packages/client/src/threadState.ts]]
- [[packages/client/src/contract.ts]]
- [[packages/client/src/database/schema/workspaceSchema.ts]]
