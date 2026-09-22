# Migrating Halo from Pi and Executor to the OpenCode v2 SDK

Briefing for a possible agent-runtime swap. It describes the current split, what the OpenCode v2 embedded SDK would take over, and the gaps that block a straight replacement.

Sources checked against this tree: workspace-server agent runtime (`HaloAgentSession`, `ToolRuntime`, `SessionRegistry`, `WorkspaceResourceLoader`) on Pi `0.85.1` and Executor `1.6.0`, and the OpenCode v2 docs for the embedded SDK, plugins, permissions, skills, providers, and code mode (September 2026).

## What Halo runs today

Two libraries share one workspace-server process. The desktop does not host the agent.

**Pi is the model loop and the transcript.** `HaloAgentSession` builds an `AgentHarness` from `@earendil-works/pi-agent-core`. Sessions are Pi `Session` objects stored by `TursoSessionRepo` in `{workspace}/.halo/state.db` (`halo_sessions` and related tables). Streaming, abort, titles, and the sidebar snapshot are projections of Pi harness events in `sessionEvents.ts`. Skills are read from `{workspace}/.agents/skills` with Pi's loader and pasted into the system prompt, along with the workspace `AGENTS.md` and Halo's own prompt in `workspacePrompt.ts`. The model is fixed: `google-vertex` / `gemini-3.8-flash`, with Application Default Credentials owned by Halo's `LLMApi`, not by Pi's auth file.

**Executor is the tool runtime.** The model sees Halo's file and shell tools plus one `exec` tool. `exec` evaluates JavaScript in QuickJS. That program calls `tools.search`, `tools['web.search']`, `tools.files.*`, integration operations, and `tools.halo.showConnectionCard`. Executor also owns the OpenAPI catalog (including Google presets), OAuth, the credential files under `.halo/executor/credentials`, and the FumaDB tables in the same `state.db`. Workspace extensions call `toolRuntime.invokePath` directly, outside a model turn. The chat UI renders nested `exec` calls and the connection card from that runtime's events.

Traces (`PiTrace`), hotkeys, and chat attachments sit on the Halo side of this boundary and subscribe to Pi or Executor.

## What the OpenCode v2 SDK is

Use `@opencode/sdk` (`OpenCode.create()`). That package hosts the v2 server in-process and routes calls through its HTTP stack in memory. It does not open a port.

`@opencode/client` is the network client for a separate `opencode serve` process. `@opencode-ai/sdk` is the older client (`createOpencode()`, default port 4096). Those are different products. Halo's fit is the embedded v2 host inside the workspace server: one host per server process, one Location for the workspace root, and Halo's existing session API in front of it.

The embedded host can:

- Create sessions, prompt, abort, and stream events.
- Run built-in read, edit, write, patch, grep, glob, shell, web search, and web fetch, with an ordered allow / deny / ask permission policy.
- Call Vertex through the `google-vertex` provider using Application Default Credentials, a project, and a location.
- Load skills on demand and read `AGENTS.md`.
- Register plugins that change the agent prompt, add tools, and mark tools for code mode. Code mode exposes one model-facing `execute` tool; nested tools keep their own permission checks.
- Talk to MCP servers, including remote OAuth.

OpenCode is MIT-licensed.

## High-level changes

| Area | Today | After a Pi replacement |
| --- | --- | --- |
| Model loop | Pi `AgentHarness` | `opencode.sessions.prompt` on one embedded host |
| Transcript | Pi entries in `halo_sessions` | OpenCode's own SQLite database |
| Live UI | `adaptPiEvent` / lane snapshots | A new adapter from `opencode.events` |
| Coding tools | Halo file and bash tools, capability-gated | OpenCode built-ins, or the same Halo tools registered as a plugin |
| System prompt | `haloSystemPrompt` plus inlined skills | An agent transform that installs Halo's prompt and instructions |
| Skills | Full skill bodies in the prompt, only `{workspace}/.agents/skills` | OpenCode skill discovery pointed at that directory; bodies load when the model calls `skill` |
| Model auth | Halo `LLMApi` around Pi | `google-vertex` on the embedded host, still using the server's ADC |
| Integrations | Executor `exec`, catalog, OAuth, connection cards | Unchanged in the first cut; see blockers |
| Extension tool calls | `toolRuntime.invokePath` | Unchanged while Executor remains |

A full removal of Executor is a second project. OpenCode's plugin tools and MCP OAuth can host individual integrations. They do not include Executor's searchable OpenAPI catalog, Google presets, credential vault, connection-card flow, or QuickJS `exec` semantics.

## Recommended cut

Replace Pi first. Keep Executor.

1. Construct one `OpenCode.create()` in `WorkspaceServer`, with the workspace directory as the Location and the database path under `.halo/` (separate from `state.db`).
2. Install a Halo plugin that sets the agent prompt, points skills at `.agents/skills`, allows the tools Halo already trusts inside the workspace, and asks for paths outside it and for secret files.
3. Register the current `exec` behavior as an OpenCode tool (or as deferred code-mode tools) so connection cards, web search, hotkeys, and integrations keep working.
4. Adapt OpenCode events into the existing `SessionSnapshot` / `SessionEvent` client contract so the chat pane stays stable.
5. Leave `halo_sessions` readable as history. New chats start in OpenCode's store.

Deleting `@earendil-works/pi-*` drops the harness, `TursoSessionRepo`'s Pi `SessionRepo` implementation, `createPiModelRuntime`, `WorkspaceResourceLoader`'s Pi skill loader, and `PiTrace`'s harness subscription. Deleting `@executor-js/*` waits until integrations, extension `invokePath`, and the connection card have a new owner.

## Blockers and gotchas

**Confirm the embedded SDK runs on Node.** The v2 install snippet uses Bun, and older OpenCode server builds import `bun:sqlite`, which Node and Electron cannot load. The workspace server is a Node process. Before designing around `OpenCode.create()`, run that call inside this repo's Node version. If the published package requires Bun, the fallback is an `opencode serve` sidecar plus `@opencode/client`, which adds a process, a port, and a second lifecycle next to the workspace server.

**Pin a v2 revision.** The v2 tool and code-mode contracts are still moving on OpenCode's `dev` branch. Package names split across `@opencode/sdk`, `@opencode/client`, and `@opencode-ai/sdk`. Depend on one resolved version and re-check the event and permission shapes when bumping.

**Existing chats do not open in the new store.** `TursoSessionRepo` writes Pi session rows into libSQL `state.db`. OpenCode stores sessions, messages, parts, and provider accounts in its own SQLite file. There is no importer. Plan on an archive view for old transcripts, or accept that they disappear from the sidebar.

**`state.db` stays shared.** Executor's FumaDB tables and Halo's trace rows live beside `halo_sessions`. Point OpenCode at a different file. Do not open `state.db` with OpenCode's migrator.

**Unanswered permission requests stall the turn.** OpenCode's base policy allows tools, then asks before reading outside the Location and before reading `.env` files. Any `ask` waits until the client replies `once`, `always`, or `reject`. Halo has no such prompt. Either auto-answer from Halo's current capability rules, or build the prompt. A custom agent still inherits the base policy.

**OpenCode's default product will leak unless the plugin narrows it.** Shipped agents include `build`, `plan`, `explore`, and hidden title/summary/compaction agents. `build` may ask questions, launch subagents, and use worktrees. `session.init` rewrites `AGENTS.md`. Session share exists on the API. Halo's cloud prompt says only the workspace home persists, services on `127.0.0.1` stay inside the VM, and the agent stays in the selected folder. The plugin should publish one Halo agent, deny subagents and worktrees, and leave `session.init` and share uncalled.

**Skill behavior changes even when the files stay put.** Halo inlines every skill body on session attach. OpenCode advertises id, name, and description, then loads the body through the `skill` tool after a permission check. The halo-extension and maui skills still need to be the ones the model can discover, or extension work will follow OpenCode's generic coding habits.

**Code mode is similar and not the same.** Both designs give the model one program tool and keep leaf tools authorized. Halo's `exec` is QuickJS, requires an explicit `return`, streams nested calls into the tool card, and turns a missing OAuth grant into `ConnectionRequiredError` plus a connection card. OpenCode's `execute` snapshots deferred tools for that request, and nested calls skip the registry hooks used by direct tools. Connection-card pauses and the current nested-call UI need an explicit mapping; they do not fall out of code mode.

**Integration credentials are a second vault.** Vertex ADC can move to OpenCode's `google-vertex` provider (`GOOGLE_CLOUD_PROJECT` or provider settings; location defaults to `us-central1`). Gmail, Drive, and the other Google presets live in Executor's credential directory and database. OpenCode's SQLite auth store is for provider accounts. Moving only the model loop must keep the Executor vault where it is.

**Extensions bypass the model.** `extensionsRouter` invokes a tool path with the server's tool runtime. OpenCode tools run inside a session Location. Keeping Executor preserves this path. Routing extension calls through a session prompt would change their latency, permissions, and error shape.

**Traces need a new subscriber.** `PiTrace` listens to harness events and forwards them through `TraceService`. The equivalent is a subscription on `opencode.events`, with the same uploader contract.

**Check the model id.** Halo hardcodes `gemini-3.8-flash`. OpenCode's Vertex catalog comes from models.dev. If that id is absent, add it under `providers.google-vertex.models` before the host will select it. ADC without a project does not enable the provider.

**Keep failures on Halo's boundary.** The public SDK returns promises. Internally OpenCode is Effect. Convert failures at the workspace-server edge into the existing tagged errors (`PromptFailedError`, `CreateAgentSessionError`, and the session-not-found family). The client API should keep returning ordinary values and throwing, and should not gain OpenCode error tags.

## End-user experience

If the first cut keeps Executor and the current client snapshot, daily chat looks the same: one workspace, streamed replies, the same file and shell behavior, `exec` for integrations, and the connection card when an account is missing. Abort still works.

These differences show up as soon as the runtime changes, even with the UI held constant:

- **Old threads.** Sessions already in `state.db` do not continue in OpenCode. People keep them as read-only history, or they leave the sidebar. Halo already cancels an unfinished Pi turn when a session is reopened, so this does not remove a resume feature.
- **Approvals.** Reading outside the workspace and opening `.env` files pauses until Halo answers. Today the file tools resolve any path the process can read, and the only limit is the system prompt. Shell and edits inside the workspace can stay silent if the plugin allows them.
- **Skills.** The agent may do a step of generic work before it loads the halo-extension skill, because the skill body is no longer preloaded.
- **Tool cards.** Native OpenCode tools emit their own part stream. Until the adapter maps them, the chat can show different labels, fewer nested `exec` rows, or a pause with no card while a permission is pending.
- **Sidebar noise.** Subagent child sessions, plan files, todos, and an OpenCode-written `AGENTS.md` appear only if the plugin fails to disable them. Worktrees would also create directories the cloud VM may not keep.
- **Accounts.** Vertex keeps using the machine's ADC, so dev sign-in stays as it is. Connected Google integrations survive only while Executor and its credential directory stay. A later Executor removal means people reconnect those accounts.
- **Model choice.** The product can stay on one Vertex model. Exposing OpenCode's `/models` catalog would be a new picker Halo does not have.

A full Executor removal is visible. The connection card, "search then call an integration" flow, hotkey tools, and Parallel web search all go away until they are rebuilt as OpenCode tools or MCP servers. Extension panes that call tools would fail or change shape at the same time.

## Suggested next step

Spike `@opencode/sdk` inside the workspace server: `OpenCode.create()` under Node, a session in `tmp/workspace`, one prompt against `google-vertex` / `gemini-3.8-flash` with ADC, and a dumped event log. That answers the runtime blocker and gives the event adapter a real payload. Leave Executor in place for that spike.
