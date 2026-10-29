# Persistent agents

Status: Phase 1 implemented and verified locally. Phases 2 and 3 remain planned; there is no new agent UI or message tool yet.

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
- Pin the agent row outside the scrolling list, above Desktop and the existing sidebar sections. Wrap circles for narrow sidebars rather than add another scroll area.
- The top-right “+” creates an agent directly; the existing Threads “+” still creates a thread. Do not add search merely because it appears in the reference.
- The creation form contains Name only. Save empty instructions initially; the user describes the agent's role in conversation. Settings still exposes Name and Instructions later. Cancel creates nothing; settings edits preserve history and apply at the next model request.
- The welcome uses ordinary text/Markdown messages, such as “Hey, I'm Chief” and “What would you like me to do?” Exact wording comes from the agent, not a client-inserted assistant bubble. Grok's avatar picker and multiple-choice onboarding card are not required for this slice.
- All agents appear in this row; there is no separate pin/unpin feature in v1. Closing a tab never deletes or marks an agent done.
- Keep approval requests, connection requests, failures, Stop, and a simple working indicator visible. Hiding calls must not hide an action the user needs to take.
- Only a successful, committed send-user-message result produces an agent message. Do not turn ordinary final assistant text into a fallback message. An agent can send several messages during one run or finish silently.
- Use text/Markdown messages first. Keep existing incoming attachments and references; a new outgoing-attachment API is not part of this slice.

## An agent owns settings and links to one continuous thread

The circle represents an agent; opening it resolves the agent's `threadId` and opens that same conversation each time. Agent metadata owns the name and instructions. The existing thread owns messages, execution, drafts, and read state; there is no second conversation or runtime:

```services
service Client "Web / Electron"
  state openThread = none
service Server "Workspace server"
  service Agents "AgentService" [[1bd8653a:packages/workspace-server/src/agents/AgentService.ts#L28-L46]]
  service Threads "ThreadManager" [[1bd8653a:packages/workspace-server/src/threads/ThreadManager.ts#L230-L257]]
  service Runtime "Thread / Pi" [[1bd8653a:packages/workspace-server/src/agent/Thread.ts#L233-L249]]
service Profile "Saved agent metadata"
  > Settings live here, not in HaloThreadDoc.
  state id = agent-123
  state threadId = thread-123
  state name = Chief
service History "Saved thread"
  > The existing thread stores messages and execution records.
  state id = thread-123
step "The circle resolves its agent's conversation"
  Client -> Agents: read agent-123
  Agents -> Profile: read settings and threadId
  Agents -> Client: Chief, thread-123
step "The client opens that same thread"
  Client -> Threads: open thread-123
  Client.openThread = thread-123
  Threads -> History: read conversation history
  Threads -> Runtime: attach thread-123
step "Messages return to the same conversation"
  Client -> Runtime: prompt thread-123
  Runtime -> Agents: read current agent settings for this model request
  Runtime -> History: persist conversation entries
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
1bd8653a
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

The public client now exposes the product action through [[1bd8653a:packages/client/src/contract.ts#L375-L381]]. This is the RPC entry point used by a future creation form:

```tsx {1,3-4} [Create an agent]
const agent = await client.agents.new({
  requestId,
  name: "Chief",
  instructions: "Help me keep track of ongoing work.",
});
// [!note agent] Returns the saved agent, including its id and threadId. UI RPC and exec tools call the same AgentService.
```

Inside `exec`, the same operations use the existing tool-result envelope. Errors must be checked before reading `data`:

```tsx [Create an agent inside exec]
const result = await tools.agents.new({ requestId, name, instructions });
if (!result.ok) throw new Error(JSON.stringify(result));
const agent = result.data;
```

`agents.new()` composes existing thread creation internally. Public `thread.new()` still means ordinary work; callers cannot supply the internal reserved thread ID. Creation saves the relationship before the agent becomes available:

```services
service Client "UI / exec"
service Agents "AgentService" [[1bd8653a:packages/workspace-server/src/agents/AgentService.ts#L48-L97]]
service Threads "ThreadManager" [[1bd8653a:packages/workspace-server/src/threads/ThreadManager.ts#L230-L257]]
service Metadata "Saved agent metadata"
  state status = absent
  state threadId = none
step "Create submits name, instructions, and a retry ID"
  Client -> Agents: agents.new(requestId, name, instructions)
step "Reserve a recoverable creation identity"
  Agents -> Metadata: reserve agent-123 linked to agent-thread-123
  Metadata.threadId = agent-thread-123
  Metadata.status = creating
step "Reuse thread creation with a stable retry identity"
  Agents -> Threads: threads.new(threadId = agent-thread-123)
  Threads -> Agents: agent-thread-123
step "Save the link before exposing the agent"
  Agents -> Metadata: commit ready = true
  Metadata.status = ready
step "Publish conversation status only after readiness"
  Agents -> Threads: publishSummary(agent-thread-123)
step "Return the agent and its conversation"
  Agents -> Client: agent-123, agent-thread-123, Chief
```

[[1bd8653a:packages/client/src/agents.ts#L17-L23]] defines the public agent record. Its `threadId` is unique in the database: one agent owns one backing conversation, and no two agents share it. Creation order belongs to the agent, not the thread's recent activity:

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

[[1bd8653a:packages/client/src/agents.ts#L3-L16]] defines creation and settings inputs. Both validate at the shared service boundary; agent identity remains separate from conversation identity:

```tsx [Creation input]
type NewAgentInput = {
  requestId: string;
  name: string;
  instructions: string;
};
```

```tsx [Settings input]
type AgentSettingsInput = {
  agentId: string;
  name: string;
  instructions: string;
};
```

[[1bd8653a:packages/workspace-server/src/agents/agentsRouter.ts#L9-L28]] and [[1bd8653a:packages/workspace-server/src/agents/agentTools.ts#L5-L39]] call one service. Error exits are shortened below; the saved reservation and ready commit are separate boundaries:

```callstack {3-10} [Create an agent through the shared service]
 result = UI RPC or exec tool(input)
-└── return ThreadManager.new(input) [[1bd8653a:packages/workspace-server/src/threads/ThreadManager.ts#L230-L257]]
+└── agent = AgentService.new(input) [[1bd8653a:packages/workspace-server/src/agents/AgentService.ts#L48-L97]]
+    ├── if saved agent is ready: return saved agent
+    ├── commit reserved agent with stable id, threadId, and ready = false
+    └── return finishCreation(agent) [[1bd8653a:packages/workspace-server/src/agents/AgentService.ts#L216-L231]]
+        ├── thread = ThreadManager.new({ threadId: agent.threadId }) [[1bd8653a:packages/workspace-server/src/threads/ThreadManager.ts#L230-L257]]
+        ├── if thread is Error: return thread
+        ├── commit agent with ready = true
+        ├── publishSummary(agent.threadId) [[1bd8653a:packages/workspace-server/src/threads/ThreadManager.ts#L838-L867]]
+        └── return agent
# [!note L5-L9] Pending records stay out of the agent roster and thread summaries; thread prompts and snapshots reject them until ready.
```

The reservation uses SHA-256 of `requestId` with distinct `agent-` and `agent-thread-` prefixes. Ordinary thread retries use `thread-`, so even identical request IDs cannot join unrelated conversations. A ready retry returns current saved settings rather than overwriting a later rename:

```tsx [Reserve or reuse the same pair]
const identity = sha256(input.requestId);
const existing = await tx.get("agents", `agent-${identity}`);
if (existing instanceof Error) return existing;
if (existing?.ready) return existing;
const agent = existing ?? {
  id: `agent-${identity}`, threadId: `agent-thread-${identity}`,
  name: input.name.trim(), instructions: input.instructions,
  createdAt: Date.now(), ready: false,
};
tx.set("agents", agent);
await db.commit(tx);
return finishCreation(agent);
// [!note L10-L11] Pseudocode abbreviates transaction setup, error conversion, and summary publication on ready retries.
```

[[1bd8653a:packages/workspace-server/src/agents/AgentService.ts#L192-L208]] completes unfinished reservations during [[1bd8653a:packages/workspace-server/src/server/WorkspaceServer.ts#L460-L469]], before normal thread recovery starts. Existing thread creation reopens an already saved backing thread instead of creating another:

```tsx [Resume interrupted creation]
for (const agent of await db.query({ collection: "agents", where: { ready: false } })) {
  const result = await finishCreation(agent);
  if (result instanceof Error) return result;
}
```

The stored record adds one internal readiness field; clients never receive it:

```tsx [Stored creation state]
type StoredAgent = AgentRecord & { ready: boolean };
```

[[1bd8653a:packages/workspace-server/src/agents/AgentService.ts#L143-L178]] saves name and instructions together and notifies subscribers. Blank names fail validation; instructions may be empty. Renaming does not call `Thread.setName`:

```tsx {2-5} [Save settings on the agent]
async function updateAgentSettings(input: AgentSettingsInput) {
  const agent = await tx.get("agents", input.agentId);
  if (agent instanceof Error) return agent;
  if (!agent?.ready || !input.name.trim()) return validationError;
  const updated = { ...agent, name: input.name.trim(), instructions: input.instructions };
  tx.set("agents", updated);
  await db.commit(tx);
  return updated;
}
// [!note L3-L4] Pseudocode omits transaction setup and domain error construction.
```

[[1bd8653a:packages/workspace-server/src/agent/Thread.ts#L233-L249]] reads current saved settings for each model request, including the first request after a restart. It adds agent identity and instructions while retaining base guidance, workspace instructions, skills, permissions, and approval rules:

```tsx {2-4} [Read current agent instructions]
async function agentInstructions(threadId) {
  const agent = await agents.findByThreadId(threadId);
  if (agent instanceof Error) throw agent;
  if (!agent) return undefined;
  return `You are the persistent agent ${JSON.stringify(agent.name)}.\n\n${agent.instructions}`;
}
// [!note agent] Pi's prompt-section boundary requires throwing failures. Absence means ordinary work; a failed lookup never silently selects ordinary behavior.
```

[[1bd8653a:packages/client/src/database/schema/agents.ts#L1-L14]] and [[1bd8653a:packages/workspace-server/src/database/migrations/20261029090000-agents.ts#L1-L16]] add `halo_agents` to the existing workspace Turso database. Both IDs have unique constraints. There is no foreign key to `halo_threads` because the recoverable reservation precedes thread creation; settings are not copied into `HaloThreadDoc`.

Two consumer E2Es in [[1bd8653a:packages/workspace-server/test/workspace.test.ts#L982-L1201]] exercise renderer RPC and exec creation, concurrent retries, roster/status subscriptions, separate histories, settings edits between model requests, restart/reopen, invalid names, and ordinary-thread isolation. Four temporary fault tests exercised saved-boundary recovery with the real Turso database and actual server startup; they were removed after passing. The message tool and transcript projections remain Phase 2, so Phase 1 does not claim to verify them.

Phase 1's API accepts empty instructions but does not start a run on creation. The revised name-only flow uses `instructions: ""`; Phase 2 adds automatic welcome execution after installing the message tool, and Phase 3 adds the name-only form. These planned additions do not change what the completed Phase 1 verified.

## Phase 2: Make speaking to the user an explicit tool action

**Today:** [[packages/web/src/main/agent/threadView.ts#threadViewItems]] shows assistant text and tool activity. [[packages/workspace-server/src/agent/ThreadProjection.ts#ThreadProjection.summary]] uses run completion or assistant entries for unread state. A hidden run could therefore produce a false unread dot.

**Proposed:** Only the built-in `send_user_message` tool adds agent text to the conversation. New agents start a welcome run automatically and use this tool to introduce themselves and ask what the user wants them to do. Later runs can send updates, continue working, or finish silently; a committed message, not hidden execution, sets unread state.

The welcome is a real model run, not placeholder transcript text. With empty saved role instructions, shared agent guidance supplies the first-run behavior:

```tsx [First conversation, before any user message]
await send_user_message({ text: "Hey, I'm Chief." });
await send_user_message({ text: "What would you like me to do?" });
// [!note L1-L2] Example output, not hard-coded copy. No user prompt or role form comes before these messages.
```

The server owns the welcome trigger so closing the pane or losing the creation response cannot lose it. Record the welcome intent with creation and submit it once through Pi's durable execution using a stable request ID; return the agent once creation and that submission are saved, without waiting for inference. The names below are planned internal pseudocode, not existing public APIs:

```callstack {3-8} [Create and start the welcome]
 agent = AgentService.new(input) [[packages/workspace-server/src/agents/AgentService.ts#AgentService.new]]
-└── return saved agent with an empty conversation
+├── save creation with a pending welcome intent
+├── finish backing-thread creation
+├── request = { kind: "agent.welcome", agentId: agent.id, requestId: "welcome:" + agent.id }
+├── accepted = enqueueWelcomeOnce(agent.threadId, request)
+├── if accepted is Error: return accepted
+├── return agent without waiting for the model
+└── durable run uses send_user_message to greet and ask one opening question
# [!note enqueueWelcomeOnce] Recovery resubmits a missing welcome with the same request ID. Opening a pane or retrying creation never starts another welcome.
```

The internal input identifies this as host-initiated work, not a user message:

```tsx [Welcome request]
type AgentWelcomeRequest = {
  kind: "agent.welcome";
  agentId: string;
  requestId: string;
};
```

[[packages/workspace-server/src/agent/Thread.ts#Thread.prompt]] currently records every public prompt as a user message. Do not reuse that path unchanged for the welcome: the trigger must not produce a fake user bubble. Confirm Pi's internal submission and replay support during implementation; add the smallest internal entry point needed, not another conversation or a recursive `ThreadManager.prompt` tool call.

Reopening the agent never repeats onboarding. If the user sends a message while the welcome is pending or running, preserve that message and let the agent respond in the same conversation rather than interrupting the user's task with a late setup question. Starting with empty role instructions does not itself add a policy for agents to rewrite saved instructions; that guidance remains to be settled.

The model receives `send_user_message` in its tool list alongside `read` and `exec`. Speaking does not require JavaScript inside `exec`, and does not finish the run. This is a direct model tool call, shown as pseudocode:

```tsx [Call the built-in message tool directly]
await send_user_message({ text: "I found two options. Checking the second one." });
// ...continue working
```

The delivery boundary is the saved result, not a transient tool-progress event:

```services
service Runtime "Thread / Pi" [[packages/workspace-server/src/agent/Thread.ts#Thread]]
service Saved "Same thread history"
  state latestMessage = none
service Pane "Agent conversation"
  state message = none
  state working = yes
step "Ordinary assistant output stays internal"
  Runtime -> Saved: save assistant text and tool execution
step "The agent calls send_user_message"
  Runtime -> Saved: commit successful result m1 with message payload
  Saved.latestMessage = m1
step "The committed message reaches the pane"
  Saved -> Pane: message m1
  Pane.message = m1
step "The agent continues working"
  Runtime -> Saved: further tool work
  Pane.working = yes
```

Resolve the separate agent record before `Thread.attach` installs native tools. Follow the direct-model exposure used by [[packages/workspace-server/src/agent/tools/files/read.ts#readTool]] and [[packages/workspace-server/src/agent/runtime/ToolRuntime.ts#ToolRuntime.createModelTools]], rather than an exec-only API. Register the message tool only when that record owns the calling thread; it takes no recipient or second conversation ID:

```callstack {2-6} [Install the message tool]
 thread = open existing or newly created conversation(threadId)
+├── agent = agentStore.findByThreadId(threadId)
+├── if agent is Error: return agent
 └── thread = Thread.attach(options, stored, agent) [[packages/workspace-server/src/agent/Thread.ts#Thread.attach]]
+    ├── if agent exists: register built-in model tool send_user_message
+    ├── if agent exists: add communication guidance and current instructions
     └── harness = Harness.open(storage, registry)
# [!note send_user_message] Ordinary threads keep their existing output and tool behavior.
```

The input is text/Markdown. The result details contain a checked message payload rather than a second database write or external notification:

```tsx [Message tool input]
type SendUserMessageInput = { text: string };
```

```tsx [Saved message payload]
type SentUserMessage = { kind: "agent.userMessage"; text: string };
```

The tool returns the payload for Pi to commit through the existing result path:

```tsx {4} [Return a message payload]
function sendUserMessage({ text }: SendUserMessageInput) {
  return {
    content: [{ type: "text", text: "Message sent." }],
    details: { kind: "agent.userMessage", text } satisfies SentUserMessage,
  };
}
// [!note details] The pane displays this only after successful commit, never from transient progress.
```

One shared decoder feeds snapshots, summaries, the transcript, search, and thread references. These consumers resolve agent membership from the separate metadata, even for unloaded threads; current title lookups use the agent's name without rewriting references already saved in past messages. Preserve raw execution for model context and diagnostics; do not use hidden narration as conversational text:

```tsx {2-5} [Project only delivered agent text]
function projectAgentMessage(entry: CommittedToolResult) {
  if (entry.toolName !== "send_user_message" || entry.isError) return;
  const sent = decodeSentUserMessage(entry.details);
  if (sent instanceof Error) return;
  return { id: entry.id, text: sent.text };
}
// [!note L5] Reconnect and replay use the same entry ID, not a fresh UI-generated message ID.
```

The visible row needs only its saved identity and text; existing user rows and host controls retain their contracts:

```tsx [Delivered message]
type DeliveredAgentMessage = { id: string; text: string };
```

Projection changes the unread cursor without changing run status:

```callstack {3-6} [Commit, project, and publish]
 publication = Pi commits tool result
 └── ThreadProjection.apply(publication) [[packages/workspace-server/src/agent/ThreadProjection.ts#ThreadProjection.apply]]
+    ├── message = projectAgentMessage(committedResult)
+    ├── if no message: retain the previous sent-message cursor
+    ├── summary.latestResultId = message.id
+    └── publish snapshot and summary with the same message ID
# [!note L4] Tool execution and silent run completion must not create unread agent messages.
```

Adapt [[packages/web/src/main/agent/useMarkThreadRead.ts#useMarkThreadRead]] to acknowledge a displayed message even while work continues. The server's existing observed-result check must still protect a newer unseen message:

```tsx [Read while the agent works]
if (isAgent && windowFocused && tabVisible && displayedMessageId) {
  await client.thread.markRead({
    sessionId: threadId,
    observedResultId: displayedMessageId,
  });
}
// [!note displayedMessageId] Do not acknowledge a message present only in the summary, not yet in the rendered transcript.
```

Baseline guidance says normal assistant text is not delivered, the message tool is the only route for user-facing text, and sending does not end work. Detailed communication style and separate-thread guidance remain later work. Keep approvals, connection requests, Stop, and runtime failures visible independently of tool rows.

Confirm Pi Durable's commit/replay contract before implementing delivery. Prove the model sees and can call `send_user_message` without invoking `exec`; ordinary threads must not receive it. Prove a restart between tool return and commit cannot duplicate a message; do not recursively append another message through `ThreadManager`.

Also prove automatic greeting with no first user message, creation retries and restart at the welcome-submission boundary, reopening without another greeting, and a user message arriving during the welcome. Cover two sends in one run, a silent run, a failed send, reconnect, a message followed by failure, and pending approval/connection controls. A failed welcome must keep the saved agent and offer retry without creating another agent or duplicating committed greeting messages.

## Phase 3: Add the pinned roster, quiet pane, and settings

**Today:** [[packages/web/src/sidebar/Sidebar.tsx#Sidebar]] renders Desktop above scrollable sections. [[packages/web/src/sidebar/ThreadsSection.tsx#ThreadsSection]] lists unfinished conversations. [[packages/web/src/main/agent/AgentPane.tsx#AgentPane]] is the existing thread UI despite its name; it supplies a Done action through the header slot.

**Proposed:** A top-right “+” opens a name-only creation form. Create opens the agent's conversation immediately, where the agent introduces itself and asks what to do; the user does not write instructions or a first message to get started. Pinned circles return to that conversation, and Settings replaces Done in its header.

The form has Name, Create, and Cancel; a nonblank name enables Create, and Enter submits. Submission calls `agents.new({ requestId, name, instructions: "" })` with the same request ID on retry. Settings later exposes Name and Instructions, while the existing Threads “+” still creates ordinary work:

```tsx [Create with a name, then talk]
const agent = await client.agents.new({ requestId, name, instructions: "" });
openConversation(agent.threadId);
// The server has queued the welcome; show working state until its messages arrive.
// The composer is usable immediately. No second setup form or mandatory first prompt.
```

Creating, returning, and editing retain one agent ID and its one backing conversation ID:

```services
service Sidebar [[packages/web/src/sidebar/Sidebar.tsx#Sidebar]]
service Pane "Conversation pane" [[packages/web/src/main/agent/AgentPane.tsx#AgentPane]]
  state openThread = none
  state header = none
service Server "Workspace server"
  state agentName = Chief
service Runtime "Agent / Pi"
step "The user enters a name and presses Create"
  Sidebar -> Server: agents.new(name, empty instructions, requestId)
step "Creation opens the agent's backing thread"
  Server -> Pane: agent-123 linked to thread-123
  Pane.openThread = thread-123
  Pane.header = Chief with Settings
step "The server starts the welcome without a user prompt"
  Server -> Runtime: durable welcome for agent-123
  Runtime -> Pane: committed greeting message
  Runtime -> Pane: committed question about what the user wants
step "The user describes the first task or role"
  Pane -> Runtime: user message in thread-123
step "Returning uses the circle, not New thread"
  Sidebar -> Pane: open agent-123's thread-123
step "Header settings edit the agent record"
  Pane -> Server: agents.update(agent-123, name Research)
  Server.agentName = Research
step "Agent metadata subscriptions update both labels"
  Server -> Sidebar: agent-123 named Research
  Server -> Pane: agent-123 named Research, same thread-123
  Pane.header = Research with Settings
```

Load and subscribe to the agent roster separately from thread summaries. Join on `threadId` for working/unread/action-needed state; names and instructions come only from the agent record. Exclude backing threads from the ordinary Threads section and Done actions, without excluding them from search or references:

```callstack {2-6} [Join agent identity to conversation status]
-sidebar = Sidebar({ threads }) [[packages/web/src/sidebar/Sidebar.tsx#Sidebar]]
+sidebar = Sidebar({ agents, threads }) [[packages/web/src/sidebar/Sidebar.tsx#Sidebar]]
+├── roster = sortAgents(agents, createdAt then ID)
+├── ordinary = threads excluding agents' backing thread IDs
+├── render circles with agent names and status from threads[agent.threadId]
+└── return existing sections with the ordinary Threads list
# [!note roster] Agent changes update the roster; conversation events update its status. Do not persist a second name or instruction copy.
```

Sort by agent creation time, not conversation activity. Missing conversation status while loading must not remove or reorder a saved agent; keep loading and errors distinct from an empty roster:

```tsx [Keep circles stable]
const roster = agents.toSorted((a, b) =>
  a.createdAt - b.createdAt || a.id.localeCompare(b.id));
const backingThreadIds = new Set(agents.map((agent) => agent.threadId));
const ordinaryThreads = threads.filter((thread) =>
  !backingThreadIds.has(thread.sessionId));
```

Use existing `/sessions/:threadId` links so saved tabs, drafts, and references keep working. Resolve the agent by backing thread ID on direct links as well as circle clicks; show lookup loading/errors rather than briefly rendering an agent as an ordinary thread. Do not add a second route or rename the existing `AgentPane` module:

```callstack {5-8} [Open the same thread pane]
 onCirclePress(agent)
 └── WorkspacePanes.open({ path: "/sessions/" + agent.threadId }) [[packages/web/src/panes/WorkspacePanes.ts#WorkspacePanes]]
     └── pane = AgentPane(threadId, threads) [[packages/web/src/main/agent/AgentPane.tsx#AgentPane]]
-        └── return regular thread header and threadViewItems(snapshot)
+        ├── agent = resolve saved agent by threadId
+        ├── if agent: rows = delivered messages + required host controls
+        ├── if agent: header = Settings; otherwise preserve Done
+        └── return shared ChatPane(rows, header, existing composer)
# [!note L5-L7] Agent metadata selects presentation; navigation still opens the original thread ID.
```

The agent branch uses the existing header slot and shared composer. The code below shows only the selected presentation; its rows reuse delivered messages and existing user/action/error shapes:

```tsx {3-5} [Agent presentation]
function AgentConversation({ agent, snapshot }) {
  return <>
    <PaneHeaderActions><AgentSettingsButton agentId={agent.id} /></PaneHeaderActions>
    <ChatPane rows={deliveredAgentRows(snapshot)}
      placeholder={`Message ${agent.name}`} />
  </>;
}
// [!note deliveredAgentRows] Includes user messages and required host controls, but no ordinary assistant text or tool rows.
```

Selected, unread, and working states remain distinct. Give each an accessible label; use a simple working cue, not per-tool descriptions or avatar animation. Closing a tab never marks the agent done.

Exercise zero/one/several agents, duplicate and long names, narrow layouts, all status states, name-only create/cancel/Enter, settings save/cancel, attachments, Stop, reconnect, and pending approval/connection controls. Verify that creation opens the conversation before the greeting finishes, the agent speaks first without a fake user bubble, the user can type while it works, and a welcome failure can be retried without another agent. Verify a rename updates the circle, open pane, tabs, and new search/reference results without changing the backing thread ID; include direct links and metadata/status arriving in either order. Extend existing sidebar/thread-view E2Es, then inspect final roster/conversation and settings captures plus a short interaction recording.

## Verification and delivery boundary

Phase 1 is implemented in the code commit above, with these checks run against that code:

- `pnpm run check-affected`: 52 tasks passed, including lint, formatting, affected typechecks, and workspace-server unit tests (62 passed).
- `pnpm --filter @get-halo/workspace-server exec vitest run test/workspace.test.ts --reporter=dot`: 61 passed, including both persistent-agent E2Es through real RPC and scripted model requests.
- `pnpm --filter @get-halo/workspace-server test:e2e --maxWorkers=1`: all 92 package E2Es passed. The initial parallel run hit one browser-test timeout; that test passed alone and the complete suite passed serially.
- Four temporary fault tests passed: interruption after reservation, after thread creation, during the ready save, and after the ready commit but before summary publication. Each reopened through actual server startup and recovered one agent/thread pair with the saved settings.

No UI changed in Phase 1, so no visual flow is claimed as verified. Phases 2 and 3 must still validate message commit/replay and the existing `apps/electron/e2e/sidebar.e2e.test.ts` and `threadView.e2e.test.ts` consumer surfaces. The phase is local only; it has not been pushed, merged, or deployed.

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
