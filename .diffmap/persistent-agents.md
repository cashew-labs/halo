# Persistent agents

Status: All three phases are implemented locally. Agents have saved identity, dynamic introductions, a native message tool, pinned circles, name-only creation, and editable settings. The pane shows delivered messages without execution rows.

Review the full flow in Phase 3: name an agent, talk in its existing conversation, return through its pinned circle, and edit its settings. The completed phases below link to their code commits. These local changes are not a release or deployment. Guidance on self-editing instructions and separate task threads remains open.

## People return to an agent, not a new thread

**Today:** Halo puts task conversations in the Threads list. Threads already persist, but each new task encourages another conversation. People must find an old thread or repeat context.

**Proposed:** People enter a name, create an agent, and land in its continuous conversation. The agent speaks first: a short introduction, then a question about what they want it to do. Agents sit in a pinned row of circles at the top of the sidebar; a separate send-user-message tool controls their visible messages while execution history stays out of the transcript.

### Settled with Tanishq

- Support multiple user-created agents.
- Put the create-agent “+” at the top right of the sidebar, like the supplied Grok Bot reference.
- Create agents through `agents.new()`, available to both the UI and agents inside `exec`. Keep ordinary thread creation separate.
- Creation asks only for a name, with no instructions field or extra setup step. Open the conversation as soon as creation succeeds; do not wait for the model to finish its greeting.
- Start a welcome run automatically. The agent sends a short introduction and asks what the user wants it to do, without waiting for a first user message.
- Save agent metadata separately: the agent owns its name and instructions and links to one specific conversation through `threadId`.
- Keep that thread's continuous history and ID for all future messages.
- Keep ordinary threads. Guidance on when an agent should create separate threads comes later.
- Use circles without avatars for now.
- Hide tool calls in agent conversations and provide a separate tool for messages to the user.
- Expose `send_user_message` directly as a built-in model tool, like `read`. It must not require an `exec` call or tool discovery.
- Keep the pane similar to a thread pane. Include a settings button in its header.

### Proposed defaults to review

- Use initials inside each circle and a name below it. Use creation order, not recent activity, so agents do not move while people work.
- Pin the agent row above Desktop and the existing sidebar sections. Wrap circles for narrow sidebars; cap the roster at 180px and scroll it when needed so many agents cannot displace the navigation.
- The top-right “+” creates an agent directly; the existing Threads “+” still creates a thread. Do not add search merely because it appears in the reference.
- The creation form contains Name only. Save empty instructions initially; the user describes the agent's role in conversation. Settings still exposes Name and Instructions later. Cancel creates nothing; settings edits preserve history and apply at the next model request.
- The welcome uses ordinary text/Markdown messages, such as “Hey, I'm Chief” and “What would you like me to do?” Exact wording comes from the agent, not a client-inserted assistant bubble. Grok's avatar picker and multiple-choice onboarding card are not required for this slice.
- All agents appear in this row; there is no separate pin/unpin feature in v1. Closing a tab never deletes or marks an agent done.
- Keep approval requests, connection requests, failures, Stop, and a simple working indicator visible. Hiding calls must not hide an action the user needs to take.
- Only a successful, committed send-user-message result produces an agent message. Do not turn ordinary final assistant text into a fallback message. An agent can send several messages during one run or finish silently.
- Use text/Markdown messages first. Keep existing incoming attachments and references; a new outgoing-attachment API is not part of this slice.

## An agent owns settings and links to one continuous thread

The circle represents an agent; opening it resolves the agent's `threadId` and opens that same conversation each time. The diff adds agent metadata to the existing thread system: name and instructions belong to the agent, while messages, execution, drafts, and read state stay in the thread. Ordinary threads keep their creation path; there is no second conversation or runtime:

```mermaid diff [Add agent metadata, reuse the thread and runtime]
 flowchart TD
   Client["UI / exec"] -->|thread.new| Threads["ThreadManager"]
   Threads -->|create or reopen| History["Saved thread"]
   History -->|attach| Runtime["Thread / Pi"]
+  Client -->|agents.new| Agents["AgentService"]
+  Agents -->|create thread| Threads
+  Agents -->|save settings| Profile["Agent metadata"]
+  Profile -->|threadId| History
+  Profile -->|current instructions| Runtime
   %% ref node:Threads [[203fa33c:packages/workspace-server/src/threads/ThreadManager.ts#L230-L257]]
   %% ref node:History [[packages/workspace-server/src/agent/ThreadProjection.ts#HaloThreadDoc]]
   %% ref node:Runtime [[203fa33c:packages/workspace-server/src/agent/Thread.ts#L233-L249]]
+  %% ref node:Agents [[203fa33c:packages/workspace-server/src/agents/AgentService.ts#L28-L46]]
+  %% ref node:Profile [[203fa33c:packages/client/src/agents.ts#L17-L23]]
```

The saved agent links to the existing conversation. Keep each value in one place rather than copying agent settings into [[packages/workspace-server/src/agent/ThreadProjection.ts#HaloThreadDoc]]:

```tsx {2-5} [One agent, one backing thread]
const agent = {
  id: "agent-123",
  threadId: "thread-123",
  name: "Chief",
  instructions: "...",
};
// [!note threadId] All messages and execution remain in this one thread. Agent ID and thread ID have distinct roles.
```

The current `ThreadSummary.agent: "pi"` names the engine; leave it unchanged. Resolve agent membership from the saved `threadId` relationship, including when an existing thread URL opens directly. Any title or membership added to a response is derived, not another saved copy. Ordinary threads keep their current saved names.

Idle runtimes can unload and reopen as they do now. Continuous history does not promise infinite model recall; keep current compaction behavior. Workspace memory and tools stay shared, and hidden execution is not a new privacy boundary.

## Goals and non-goals

V1 delivers name-only creation, an agent-led welcome, a stable roster, reopening, editable name/instructions, an explicit message tool, a quiet transcript, and useful working/unread/action-needed state. Normal threads retain their current behavior, URLs, and tools.

Defer avatars, model/tool selectors, private per-agent memory, independent computers, group chats, agent-to-agent routing, new automation controls, desktop/push notifications, converting existing threads, deletion/archive controls, and guidance about creating task threads. Existing thread tools remain available; the new guidance is not a restriction on those tools.

The following three phases are implementation boundaries, not three separately released features. Ship the full user flow only after all three work together. The `agents.new/list/update` product API is settled; internal helper names in pseudocode and call stacks are illustrative.

## ✅ Phase 1: Give each agent a saved identity and conversation

**Today:** Creating a thread returns an ID and an empty conversation. The title comes from its saved name or first user message. There is no product-agent profile or editable role.

**Proposed:** `agents.new()` creates a saved agent and its one backing thread. Returning to Chief reopens that thread, not a new session. This phase supplies the same creation, listing, and settings operations to the UI and `exec`, preparing the forms and roster in Phase 3.

```changes
203fa33c
packages/client/src/agents.ts
packages/client/src/contract.ts
packages/workspace-server/src/agents/agentsRouter.ts
packages/workspace-server/src/agents/agentTools.ts
packages/workspace-server/src/agents/AgentService.ts
packages/workspace-server/src/threads/ThreadManager.ts
packages/workspace-server/src/agent/Thread.ts
packages/client/src/database/schema/agents.ts
packages/workspace-server/src/database/migrations/20261029090000-agents.ts
packages/workspace-server/src/server/WorkspaceServer.ts
packages/workspace-server/test/workspace.test.ts
```

The public client now exposes the product action through [[203fa33c:packages/client/src/contract.ts#L375-L381]]. This is the RPC entry point used by a future creation form:

```tsx {1,3-4} [Create an agent]
const agent = await client.agents.new({
  requestId,
  name: "Chief",
  instructions: "",
});
// [!note agent] Returns id and threadId through the same service used by exec. Empty instructions support the planned name-only form; automatic greetings are not implemented yet.
```

Inside `exec`, the same operations use the existing tool-result envelope. Errors must be checked before reading `data`:

```tsx [Create an agent inside exec]
const result = await tools.agents.new({ requestId, name, instructions });
if (!result.ok) throw new Error(JSON.stringify(result));
const agent = result.data;
```

[[203fa33c:packages/client/src/agents.ts#L17-L23]] defines the public agent record. Its `threadId` is unique in the database: one agent owns one backing conversation, and no two agents share it. Creation order belongs to the agent, not the thread's recent activity:

```tsx {3} [Saved agent metadata]
type AgentRecord = {
  id: string;
  threadId: string;
  name: string;
  instructions: string;
  createdAt: number;
};
// [!note threadId] The agent record owns the relationship. Do not also persist agentProfile or agentId in HaloThreadDoc.
```

`agents.list()` and `agents.watch()` return ready records in creation order. Settings call `agents.update()` with the agent ID. Conversation prompting, subscriptions, Stop, and read receipts continue to use the backing thread ID:

```tsx [Agent operations]
const roster = await client.agents.list();
const changes = await client.agents.watch(undefined, { signal });
await client.agents.update({ agentId: agent.id, name, instructions });
await client.thread.prompt({ sessionId: agent.threadId, requestId, text });
// [!note changes] The watch yields an initial roster, then saved changes. The existing RPC keeps sessionId as its payload key.
```

[[203fa33c:packages/workspace-server/src/agents/agentsRouter.ts#L9-L28]] and [[203fa33c:packages/workspace-server/src/agents/agentTools.ts#L5-L39]] call one service. `agents.new()` reserves metadata, then composes thread creation internally. Public `thread.new()` still creates ordinary work; callers cannot supply the internal reserved thread ID. Error exits are shortened below:

```callstack {3-10} [Create an agent through the shared service]
 result = UI RPC or exec tool(input)
-└── return ThreadManager.new(input) [[203fa33c:packages/workspace-server/src/threads/ThreadManager.ts#L230-L257]]
+└── agent = AgentService.new(input) [[203fa33c:packages/workspace-server/src/agents/AgentService.ts#L48-L97]]
+    ├── if saved agent is ready: return saved agent
+    ├── commit reserved agent with stable id, threadId, and ready = false
+    └── return finishCreation(agent) [[203fa33c:packages/workspace-server/src/agents/AgentService.ts#L216-L231]]
+        ├── thread = ThreadManager.new({ threadId: agent.threadId }) [[203fa33c:packages/workspace-server/src/threads/ThreadManager.ts#L230-L257]]
+        ├── if thread is Error: return thread
+        ├── commit agent with ready = true
+        ├── publishSummary(agent.threadId) [[203fa33c:packages/workspace-server/src/threads/ThreadManager.ts#L838-L867]]
+        └── return agent
# [!note L5-L9] Pending records stay out of the agent roster and thread summaries; thread prompts and snapshots reject them until ready.
```

The reservation uses SHA-256 of `requestId` with distinct `agent-` and `agent-thread-` prefixes. Ordinary retries use `thread-`, so identical request IDs cannot join unrelated conversations. A ready retry returns current saved settings, preserving later edits; an unfinished record retains `ready: false` internally and stays out of rosters and thread summaries.

[[203fa33c:packages/workspace-server/src/agents/AgentService.ts#L192-L208]] completes unfinished reservations during [[203fa33c:packages/workspace-server/src/server/WorkspaceServer.ts#L460-L469]], before normal thread recovery starts. It reuses an already saved backing thread and publishes status only once creation is ready.

[[203fa33c:packages/client/src/agents.ts#L3-L16]] defines the inputs validated by the shared service. [[203fa33c:packages/workspace-server/src/agents/AgentService.ts#L143-L178]] saves name and instructions together and notifies subscribers. Blank names fail validation; instructions may be empty. Renaming does not call `Thread.setName`.

[[203fa33c:packages/workspace-server/src/agent/Thread.ts#L233-L249]] reads current saved settings for each model request, including the first request after a restart. It adds agent identity and instructions while retaining base guidance, workspace instructions, skills, permissions, and approval rules:

```tsx {2-4} [Read current agent instructions]
async function agentInstructions(threadId) {
  const agent = await agents.findByThreadId(threadId);
  if (agent instanceof Error) throw agent;
  if (!agent) return undefined;
  return `You are the persistent agent ${JSON.stringify(agent.name)}.\n\n${agent.instructions}`;
}
// [!note agent] Pi's prompt-section boundary requires throwing failures. Absence means ordinary work; a failed lookup never silently selects ordinary behavior.
```

[[203fa33c:packages/client/src/database/schema/agents.ts#L1-L14]] and [[203fa33c:packages/workspace-server/src/database/migrations/20261029090000-agents.ts#L1-L16]] add `halo_agents` to the existing workspace Turso database. Both IDs have unique constraints. There is no foreign key to `halo_threads` because the recoverable reservation precedes thread creation; settings are not copied into `HaloThreadDoc`.

Two consumer E2Es in [[203fa33c:packages/workspace-server/test/workspace.test.ts#L982-L1201]] exercise renderer RPC and exec creation, concurrent retries, roster/status subscriptions, separate histories, settings edits between model requests, restart/reopen, invalid names, and ordinary-thread isolation. Four temporary fault tests exercised saved-boundary recovery with the real Turso database and actual server startup; they were removed after passing. The message tool and transcript projections remain Phase 2, so Phase 1 does not claim to verify them.

At the Phase 1 commit, creation accepts empty instructions but does not start a run. Phase 2 below adds the dynamic introduction, and Phase 3 still adds the name-only form with `instructions: ""`. These additions do not change what the Phase 1 checks verified.

## ✅ Phase 2: Make speaking to the user an explicit tool action

**Today:** Before this phase, the thread pane showed assistant text and tool activity. Run completion or assistant entries set unread state, so hidden execution could produce a false unread dot.

**Proposed:** Only the built-in `send_user_message` tool adds agent text to the conversation. New agents start a welcome run automatically and use this tool to introduce themselves and ask what the user wants them to do. Later runs can send updates, continue working, or finish silently; a committed message, not hidden execution, sets unread state.

```changes
866ef8d9
packages/web/src/main/agent/threadView.ts
packages/workspace-server/src/agents/AgentService.ts
packages/workspace-server/src/agent/Thread.ts
packages/workspace-server/src/agent/tools/sendUserMessage.ts
packages/client/src/threadState.ts
packages/workspace-server/src/agent/ThreadProjection.ts
packages/web/src/main/agent/useMarkThreadRead.ts
packages/workspace-server/src/threads/ThreadManager.ts
packages/workspace-server/src/workspace/WorkspaceSearch.ts
packages/workspace-server/test/workspace.test.ts
```

The welcome is a real model run, not placeholder transcript text. It can use the agent's name, instructions, and available memory to choose useful suggestions. With empty saved role instructions, shared agent guidance supplies the first-run behavior:

```tsx [First conversation, before any user message]
await send_user_message({ text: "Hey, I'm Chief." });
await send_user_message({ text: "What would you like me to do?" });
// [!note L1-L2] Example output, not hard-coded copy. No user prompt or role form comes before these messages.
```

The server owns the trigger. The existing pending creation record keeps it recoverable; the server submits an ordinary prompt with the stable ID `create:<agentId>` before marking that record ready. Creation returns after admission, not inference:

```callstack {3-9} [Create and start the introduction]
 agent = AgentService.new(input) [[866ef8d9:packages/workspace-server/src/agents/AgentService.ts#L55-L104]]
-└── return saved agent with an empty conversation
+└── finishCreation(agent) [[866ef8d9:packages/workspace-server/src/agents/AgentService.ts#L225-L247]]
+    ├── create or reopen agent.threadId
+    ├── accepted = ThreadManager.initialize({ threadId, requestId: "create:" + agent.id, prompt }) [[866ef8d9:packages/workspace-server/src/threads/ThreadManager.ts#L285-L297]]
+    │   └── Thread.start({ prompt, requestId }) [[866ef8d9:packages/workspace-server/src/agent/Thread.ts#L597-L608]]
+    │       └── send hidden input through Pi's normal durable admission
+    ├── if accepted is Error: return accepted
+    ├── save ready = true and publish the thread summary
+    └── return agent without waiting for the model
# [!note requestId] Recovery resubmits the same request ID. Pi deduplicates admission; reopening or retrying creation never starts another introduction.
```

There is no welcome message type or fixed greeting. [[866ef8d9:packages/workspace-server/src/agent/Thread.ts#L597-L608]] records generic hidden presentation (`halo.internal`) for an ordinary Pi input on the same thread. The prompt asks the model to use its name, instructions, and memory, and prefer an already-received task over late onboarding:

```tsx [Ordinary host-initiated input]
await thread.start({
  prompt: "Introduce yourself using your name, instructions, and available memory...",
  requestId: `create:${agent.id}`,
});
// [!note prompt] This is model guidance, not greeting copy or a user-authored message.
```

[[866ef8d9:packages/workspace-server/src/agent/Thread.ts#L610-L648]] saves presentation under the request ID and calls Pi's existing `conversation.submit` with `whenBusy: "steer"`. Public prompts retain their user bubbles; internal input does not create one. No second conversation, recursive prompt tool, or separate delivery write is involved.

Reopening the agent never repeats onboarding. If the user sends a message while the welcome is pending or running, preserve that message and let the agent respond in the same conversation rather than interrupting the user's task with a late setup question. Starting with empty role instructions does not itself add a policy for agents to rewrite saved instructions; that guidance remains to be settled.

The model receives `send_user_message` alongside `read` and `exec`; speaking neither requires `exec` nor ends the run. Compare the same conversation path before and after: execution stays saved, but only a committed send reaches the agent transcript.

```services diff
 service Runtime "Thread / Pi" [[866ef8d9:packages/workspace-server/src/agent/Thread.ts#L203-L266]]
 service Saved "Same thread history"
   state latestMessage = none
 service Pane "Conversation pane"
   state message = none
   state working = yes
 start "Separate execution from messages to the user"
   > Today, assistant narration and tool activity reach the thread pane. Proposed agent conversations retain that execution internally and show only committed sends; work can continue after a send.
 step "Save ordinary assistant text and execution"
   Runtime -> Saved: save assistant text and tool execution
-  Saved -> Pane: assistant narration and tool rows
-  Pane.message = assistant narration
+step "Commit an explicit send_user_message result"
+  Runtime -> Saved: commit successful result m1 with message payload
+  Saved.latestMessage = m1
+step "Deliver the committed message"
+  Saved -> Pane: message m1
+  Pane.message = m1
 step "Continue working"
   Runtime -> Saved: further tool work
   Pane.working = yes
```

[[866ef8d9:packages/workspace-server/src/agent/Thread.ts#L203-L266]] resolves the separate agent record before installing native tools. The message tool follows the direct-model exposure used by [[packages/workspace-server/src/agent/tools/files/read.ts#readTool]] and [[packages/workspace-server/src/agent/runtime/ToolRuntime.ts#ToolRuntime.createModelTools]]. Only agent-owned threads receive it; it takes no recipient or second conversation ID:

```callstack {2-6} [Install the message tool]
 thread = Thread.attach(options, stored) [[866ef8d9:packages/workspace-server/src/agent/Thread.ts#L203-L266]]
+├── agent = options.agents.findByThreadId(stored.metadata.id)
+├── if agent is Error: return agent
+├── if agent exists: register sendUserMessageTool [[866ef8d9:packages/workspace-server/src/agent/tools/sendUserMessage.ts#L8-L25]]
+├── read current name, instructions, and communication guidance per model request
 └── harness = Harness.open(storage, registry)
# [!note sendUserMessageTool] Ordinary threads keep their existing output and tool behavior.
```

[[866ef8d9:packages/workspace-server/src/agent/tools/sendUserMessage.ts#L8-L25]] accepts nonblank text/Markdown and returns a checked payload in tool-result details. Pi commits it through its existing result path. The tool declares `replay: "safe"`: rerunning it produces data, not another external send:

```tsx {4} [Return a message payload]
function sendUserMessage({ text }: { text: string }) {
  return {
    content: [{ type: "text", text: "Message sent." }],
    details: { kind: "agent.userMessage" as const, text },
  };
}
// [!note details] The pane displays this only after successful commit, never from transient progress.
```

Snapshots retain raw execution for model context, approvals, and diagnostics; `threadMessages` remains a raw-history helper. Optional `agentId` on snapshots and summaries identifies agent-owned conversations. The shared [[866ef8d9:packages/client/src/threadState.ts#L480-L491]] decoder feeds the transcript, unread state, search, and thread references:

```tsx {2-4} [Project only delivered agent text]
function deliveredText(entry: HaloEntry) {
  const sent = agentUserMessage(entry);
  if (sent === undefined) return;
  return { id: sent.id, text: sent.text };
}
// [!note agentUserMessage] Accepts only successful committed native tool results with a valid agent.userMessage payload.
// [!note id] Reconnect and replay use the same entry ID, not a fresh UI-generated message ID.
```

[[866ef8d9:packages/workspace-server/src/threads/ThreadManager.ts#L299-L329]] and [[866ef8d9:packages/workspace-server/src/workspace/WorkspaceSearch.ts#L308-L350]] resolve membership even for unloaded threads. New search and reference results include user input and delivered agent text, but exclude hidden narration and the kickoff prompt. Current titles use the agent's name without rewriting references already saved in past messages.

For agent threads, a committed sent message replaces run completion or assistant narration as the source of the unread cursor. Hidden work and failed sends retain the previous cursor; snapshots and summaries publish the same delivered message ID. Run status and ordinary-thread unread behavior stay unchanged:

```mermaid diff [Only delivered agent messages advance unread state]
 flowchart TD
   Commit["Committed execution"] --> Projection["ThreadProjection"]
   Cursor["Unread cursor"]
-  Projection -->|run / reply| Cursor
+  Projection --> Decoder{"Successful send_user_message?"}
+  Decoder -->|yes| Cursor
+  Decoder -->|no| Keep["Keep previous cursor"]
   Cursor --> Summary["ThreadSummary"]
+  Keep --> Summary
   %% ref node:Projection [[866ef8d9:packages/workspace-server/src/agent/ThreadProjection.ts#L59-L92]]
   %% ref node:Cursor [[866ef8d9:packages/workspace-server/src/agent/ThreadProjection.ts#L134-L163]]
   %% ref node:Summary [[866ef8d9:packages/client/src/rpc.ts#L7-L19]]
```

[[866ef8d9:packages/web/src/main/agent/useMarkThreadRead.ts#L32-L108]] acknowledges an observed delivered message even while work continues. The server's existing observed-result check still protects a newer unseen message:

```tsx [Read while the agent works]
if (isAgent && windowFocused && tabVisible && displayedMessageId) {
  await client.thread.markRead({
    sessionId: threadId,
    observedResultId: displayedMessageId,
  });
}
// [!note displayedMessageId] Do not acknowledge a message present only in the summary, not yet in the rendered transcript.
```

Baseline guidance says normal assistant text is not delivered, the message tool is the only route for user-facing text, and sending does not end work. Detailed communication style and separate-thread guidance remain later work. [[866ef8d9:packages/web/src/main/agent/threadView.ts#L131-L287]] keeps user attachments/references, approvals, connection requests, interruptions, and a generic Working indicator visible while hiding tool rows and ordinary assistant text. The shared pane retains failures and Stop.

**Verified:** The native tool commits only data; Pi's existing commit and safe-replay path owns delivery. Consumer E2Es in [[866ef8d9:packages/workspace-server/test/workspace.test.ts]] cover direct model exposure and isolation from ordinary threads, automatic introduction without a user message, two sends during one run, failed sends, silent completion, read receipts during work, stale receipt protection, restart with stable delivered IDs, private-text exclusion from search/references, memory/name in the first request, an incoming task during an interrupted introduction, and delivery followed by provider failure. [[866ef8d9:packages/web/src/main/agent/threadView.test.ts]] covers quiet rows, transient-output exclusion, approvals/connections, attachments/references, and stable message IDs.

Two temporary recovery probes used the real Turso store and Pi harness: interrupt before admission, and lose the response after admission. Reopening recovered exactly one introduction submission and delivery in both cases. They were removed after verification. A failed model run preserves the agent and committed messages; Phase 3 verifies continuing through the existing composer, without a new welcome type.

At the Phase 2 commit, the live Electron consumer introduced “Reading guide” with model-chosen history-book suggestions. A user request produced a note, hidden execution with Working/Stop, and a recommendation. The active pane acknowledged delivered messages; no kickoff bubble, tool rows, or private narration appeared. That commit did not yet include pinned circles or settings.

## ✅ Phase 3: Add the pinned roster, name-only creation, and settings

**Today:** Before this phase, the pane already rendered agent messages without tool rows, and creation started a dynamic introduction. There was no agent roster or creation/settings form. Backing conversations appeared under Threads, and their header still supplied Done.

**Proposed:** A top-right “+” opens a name-only creation form. Create opens the agent's conversation without waiting for its introduction; the user does not write instructions or a first message to get started. Pinned circles return to that conversation, and Settings replaces Done in its header. Reuse Phase 2's message projection and working/read state rather than add another transcript path.

```changes
c1015cec
packages/web/src/sidebar/AgentsSection.tsx
packages/web/src/agents/AgentDialog.tsx
packages/web/src/main/agent/AgentPane.tsx
packages/web/src/agents/AgentSettingsButton.tsx
packages/web/src/panes/PaneWorkspace.tsx
packages/web/src/api/WorkspaceUpdatesProvider.tsx
packages/web/src/api/ConnectionService.ts
packages/web/src/sidebar/ThreadsSection.tsx
apps/electron/e2e/sidebar.e2e.test.ts
```

[[c1015cec:packages/web/src/agents/AgentDialog.tsx#L25-L182]] supplies Name, Create, and Cancel; a nonblank name enables Create, and Enter submits. A pending submission disables dismissal and repeat submission. After a failed creation request, Retry retains the original ID and input, and the name stays read-only; cancel/reopen starts a fresh draft. Settings exposes Name and Instructions, while the Threads “+” still creates ordinary work:

```tsx [Create with a name, then talk]
const agent = await client.agents.new({ requestId, name, instructions: "" });
openConversation(agent.threadId);
// [!note L1] The server saves the agent and admits an ordinary introduction prompt before returning; it does not wait for inference.
// [!note L2] The composer is usable immediately. No second setup form or mandatory first prompt.
```

Creating, returning, and editing retain one agent ID and its one backing conversation ID:

```services
service Sidebar [[c1015cec:packages/web/src/sidebar/AgentsSection.tsx#L30-L96]]
service Pane "Conversation pane" [[c1015cec:packages/web/src/main/agent/AgentPane.tsx#L110-L177]]
  state openThread = none
  state header = none
service Server "Workspace server"
  state agentName = Chief
service Runtime "Agent / Pi"
start "Name an agent, then talk in its one conversation"
  > Creation saves the agent and queues its welcome without waiting for inference. The pane opens immediately; returning and changing settings keep the same backing thread.
step "The user enters a name and presses Create"
  Sidebar -> Server: agents.new(name, empty instructions, requestId)
step "Creation admits the ordinary introduction prompt"
  Server -> Runtime: hidden input on thread-123, requestId create:agent-123
step "Creation opens the agent's backing thread"
  Server -> Pane: agent-123 linked to thread-123
  Pane.openThread = thread-123
  Pane.header = Chief with Settings
step "The model chooses and delivers its introduction"
  Runtime -> Pane: committed send_user_message text
step "The user describes the first task or role"
  Pane -> Runtime: user message in thread-123
step "Returning uses the circle, not New thread"
  Sidebar -> Pane: open agent-123's thread-123
step "Header settings edit the agent record"
  Pane -> Server: agents.update(agentId agent-123, name Research, instructions)
  Server.agentName = Research
step "Agent metadata subscriptions update both labels"
  Server -> Sidebar: agent-123 named Research
  Server -> Pane: agent-123 named Research, same thread-123
  Pane.header = Research with Settings
```

[[c1015cec:packages/web/src/api/WorkspaceUpdatesProvider.tsx#L59-L83]] opens one shared agent subscription, separate from thread summaries. It retains the roster on reconnect and keeps loading, empty, and error states distinct. [[c1015cec:packages/web/src/api/ConnectionService.ts#L245-L265]] admits `agents.watch` during startup synchronization; otherwise the new subscription causes a reconnect loop before the workspace becomes ready.

The roster joins conversation status on `threadId`; names and instructions come only from the agent record. Backing threads move out of the ordinary Threads section through `ThreadSummary.agentId`, but both surfaces open the existing pane and remain searchable:

```mermaid diff [Pinned agents and ordinary threads share the existing pane]
 flowchart TD
-  Threads["Thread summaries"] --> List["Threads section"]
+  Threads["Thread summaries"] -->|ordinary only| List["Threads section"]
+  Agents["Agent metadata"] -->|names and order| Roster["Pinned agent circles"]
+  Threads -->|status| Roster
   List -->|threadId| Pane["Existing conversation pane"]
+  Roster -->|backing threadId| Pane
-  Pane --> Done["Done action"]
+  Pane -->|ordinary thread| Done["Done action"]
+  Pane -->|agent thread| Settings["Settings action"]
   %% ref node:Threads [[packages/client/src/rpc.ts#ThreadSummary]]
   %% ref node:List [[c1015cec:packages/web/src/sidebar/ThreadsSection.tsx#L13-L22]]
   %% ref node:Pane [[c1015cec:packages/web/src/main/agent/AgentPane.tsx#L110-L177]]
+  %% ref node:Agents [[203fa33c:packages/client/src/agents.ts#L17-L23]]
+  %% ref node:Roster [[c1015cec:packages/web/src/sidebar/AgentsSection.tsx#L98-L188]]
```

The server already orders agents by creation time and ID; the roster preserves that order, even while status is missing. Circles show a letter and a name, with selected, unread, and working cues. Full names remain available through accessible labels and tooltips; the visible label truncates long names. Tooltips sit above circles so they do not cover the next agent. Circles wrap in a roster bounded at 180px, leaving Desktop and the other sections available.

Existing `/sessions/:threadId` links preserve saved tabs, drafts, and references. The pane resolves metadata by backing thread ID on direct links and circle clicks, deferring agent presentation and read receipts while metadata loads. The rows still come from [[866ef8d9:packages/web/src/main/agent/threadView.ts#L131-L287]]; this phase changes navigation and controls:

```callstack {5-7} [Open the same thread pane]
 onCirclePress(agent)
 └── WorkspacePanes.open({ path: "/sessions/" + agent.threadId }) [[packages/web/src/panes/WorkspacePanes.ts#WorkspacePanes]]
     └── pane = AgentPane(threadId, threads) [[c1015cec:packages/web/src/main/agent/AgentPane.tsx#L110-L177]]
-        └── return Done header and existing conversation rows
+        ├── agent = resolve saved agent by threadId
+        ├── if agent: header = Settings; otherwise preserve Done
+        └── return shared ChatPane with existing rows, drafts, and composer
# [!note L5-L7] Agent metadata selects header controls; navigation still opens the original thread ID.
```

The agent branch uses the existing header slot and shared composer. This shortened pseudocode shows that boundary; [[c1015cec:packages/web/src/agents/AgentSettingsButton.tsx#L7-L23]] owns the settings dialog:

```tsx {3-5} [Agent presentation]
function AgentConversation({ agent, snapshot }) {
  return <>
    <PaneHeaderActions><AgentSettingsButton agent={agent} /></PaneHeaderActions>
    <ChatPane rows={threadViewItems(snapshot)}
      placeholder={`Message ${agent.name}`} />
  </>;
}
// [!note threadViewItems] Phase 2 already includes user messages and required host controls, but no ordinary assistant text or tool rows for agents.
```

[[c1015cec:packages/web/src/panes/PaneWorkspace.tsx#L47-L82]] uses current agent names in tabs and headers. The composer and new reference suggestions do the same, while older messages retain their original text. Closing a tab never marks the agent done.

Settings saves Name and Instructions through `agents.update`; cancel changes neither. Instructions apply to the next model request, and renaming keeps the thread and draft intact. The agent can already call that API through `exec`, but when it should rewrite its own instructions remains a guidance decision. There is no automatic role saving or mandatory role form. Guidance about separate task threads also remains deferred.

Two consumer tests in [[c1015cec:apps/electron/e2e/sidebar.e2e.test.ts#L230-L447]] cover name-only create/cancel/Enter, opening and typing before inference, native introduction delivery without narration or tool rows, settings cancel/save, instructions on the next request, draft/history retention after rename and reload, duplicate/long names, creation order, working/unread/read state, and narrow-sidebar navigation. Existing thread-view tests retain attachment, Stop, queue, connection, and ordinary-thread coverage. A temporary Electron probe also failed the introduction through the model endpoint, then sent a user message and reloaded: it recovered in the same agent/thread pair. Recovery uses the existing composer, not a special welcome type or a second agent.

## Verification and delivery boundary

Phase 1 is implemented in the code commit above, with these checks run against that code:

- `pnpm run check-affected`: 52 tasks passed, including lint, formatting, affected typechecks, and workspace-server unit tests (62 passed).
- `pnpm --filter @get-halo/workspace-server exec vitest run test/workspace.test.ts --reporter=dot`: 61 passed, including both persistent-agent E2Es through real RPC and scripted model requests.
- `pnpm --filter @get-halo/workspace-server test:e2e --maxWorkers=1`: all 92 package E2Es passed. The initial parallel run hit one browser-test timeout; that test passed alone and the complete suite passed serially.
- Four temporary fault tests passed: interruption after reservation, after thread creation, during the ready save, and after the ready commit but before summary publication. Each reopened through actual server startup and recovered one agent/thread pair with the saved settings.

Phase 2 is implemented in `866ef8d9`, with these checks run against that code:

- `TURBO_SCM_BASE=origin/main pnpm run check-affected`: 57 tasks passed. The same tasks also passed without cache reuse through `TURBO_SCM_BASE=origin/main pnpm exec turbo run typecheck lint format:check test:unit --affected --force`. Existing platform-gated desktop unit tests remained skipped; this is not a packaged Electron E2E result.
- `pnpm --filter @get-halo/workspace-server test:e2e --maxWorkers=1`: all 94 package E2Es passed across five files.
- `pnpm --filter @get-halo/web exec vitest run src/main/agent/threadView.test.ts`: all three projection tests passed; the affected check also passed all 11 web unit tests.
- Two temporary recovery probes passed with real Turso/Pi admission, covering interruption before admission and response loss after admission. Both recovered exactly one introduction submission and delivery; scratch tests were removed.
- The real development Electron pane was exercised with model inference, native sends, hidden work, Working/Stop, and active-pane read receipts. Introduction, running, and completed states were captured and inspected, along with a pointer-driven reply recording.

Phase 3 is implemented in `c1015cec`, with these checks:

- `TURBO_SCM_BASE=origin/main pnpm run check-affected`: 57 tasks passed, including web/desktop lint, formatting, affected typechecks, and unit tests.
- `pnpm --filter @get-halo/desktop test:e2e:build`: packaged the final Electron application successfully.
- `HALO_USE_SWIFTSHADER=1 xvfb-run -a pnpm --filter @get-halo/desktop test:e2e:run e2e/sidebar.e2e.test.ts e2e/threadView.e2e.test.ts --workers=1`: 24 passed, one new sidebar test timed out because it selected the rich-text composer as a textbox. All 19 thread-view scenarios passed. Using the existing `Message` label fixed the new test; it then passed alone and in the final sidebar run.
- `HALO_USE_SWIFTSHADER=1 xvfb-run -a pnpm --filter @get-halo/desktop test:e2e:run e2e/sidebar.e2e.test.ts e2e/.tmp-tests/agentsFailure.e2e.test.ts --workers=1`: all seven passed against the final packaged app: six permanent sidebar tests and one temporary introduction-failure recovery probe. The probe checked continued messaging, reload, and the same agent/thread pair; it was removed afterward.
- The running development app generated a real introduction through the native message tool. Desktop and 390px roster/settings captures and a pointer-driven create/cancel, return, and settings recording were inspected. Names truncate intentionally; their accessible labels and tooltips retain the full names. These are desktop Chromium layouts, not a real phone test.

The three phases form the local feature; they have not been released or deployed. Dedicated transport-fault injection for the new forms and every metadata/status arrival ordering were not separately executed. Brain and Graph could not run in this session: the installed CLI lacks the Brain command and Graph plugin. Tracked plans, current source, and executed tests supplied the bounded fallback; neither tool was installed or repaired.

## References

- User's Grok Bot references in this planning thread: circles at the top, top-right create control, name-only creation, and a new bot greeting before the user writes. Avatar artwork, color pickers, and multiple-choice onboarding cards are not in scope.
- [Grok Bot design write-up](https://x.ai/news/designing-grok-bot): persistent bot roster, lightweight presence, and separating role context from shared capabilities.
- [Grok Bot chat documentation](https://docs.x.ai/grok-bot/chat-and-collaboration): continuous messaging, work redirection, and collaboration. It also describes visible tool activity; Halo's message-only agent transcript is an intentional difference.
- [[packages/client/src/rpc.ts#ThreadSummary]] and [[packages/client/src/contract.ts]]: public summary and thread RPC contracts.
- [[packages/workspace-server/src/agent/ThreadProjection.ts]] and [[packages/workspace-server/src/agent/threadEvents.ts]]: persisted metadata, snapshots, summaries, and event mapping.
- [[packages/workspace-server/src/agent/Thread.ts]] and [[packages/workspace-server/src/agent/tools/execTool.ts]]: native tool registration and committed tool result details.
- [[packages/workspace-server/src/agent/WorkspaceResourceLoader.ts]] and [[packages/workspace-server/src/agent/workspacePrompt.ts]]: base prompt, workspace guidance, skills, and current shared-memory contract.
- [[packages/workspace-server/src/threads/ThreadManager.ts]] and [[packages/workspace-server/src/threads/threadTools.ts]]: lifecycle, creation, references, and cross-thread access.
- [[packages/web/src/sidebar/Sidebar.tsx]], [[packages/web/src/sidebar/ThreadsSection.tsx]], [[packages/web/src/main/agent/AgentPane.tsx]], and [[packages/web/src/main/agent/threadView.ts]]: current sidebar and conversation consumer.
- [[packages/web/src/main/agent/useMarkThreadRead.ts]], [[packages/web/src/panes/PaneWorkspace.tsx]], and [[packages/web/src/panes/PaneHeader.tsx]]: read receipts, tab titles, and header action slots.
