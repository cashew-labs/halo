# Inference dependency

`WorkspaceServer.start({ config, host })` requires an `LLMApi` on `host`. Each
durable thread uses an in-memory Pi `Models` collection backed by that shared API.
Automatic agent trace recording is not wired into the durable thread runtime;
consumers can use the explicit trace API and its upload transport. Threads do not
discover providers, select a default model, or load model credentials.

`LLMApi` exposes the assigned model's metadata and `stream(context, options)`, using Pi's normalized `TranscriptContext` and event types. Pi `Models` normalizes prompt and tool declarations before calling it; direct consumers must call Pi's `normalizeContext()` first. The implementation owns inference transport and authentication. Forward cancellation through `options.signal`. Halo continues to own tools, conversation state, and persistence. There is no model-selection or model-list API yet.

For runtime-authenticated workspaces, the standalone bootstrap uses `createOpenAILLMApi` with the control-plane inference URL and the workspace token. The control plane owns the Together key. Runtime-less workspaces retain the direct path: without `HALO_LLM_CONFIG`, the bootstrap reads `together-ai-api-key` from GCP Secret Manager in `halo-relay` using Application Default Credentials and supplies `together/deepseek-ai/DeepSeek-V4.1-Flash` with its explicit capabilities, limits, and Together compatibility settings. The installed Pi catalog predates this model. The default reasoning level is `low`; stream options can override it. Credentials stay in memory, and this path does not discover local Pi configuration files.

Control-plane inference authenticates the workspace token on every request and forwards only the configured model request. The standalone bootstrap supplies this transport through `LLMApi`; the reusable server receives it from its host and does not load the model key.

`createOpenAILLMApi({ model, apiKey, reasoning })` implements `LLMApi` using Pi's OpenAI Chat Completions client. The supplied model includes `baseUrl` and its capabilities and limits. Server hosts can set `HALO_LLM_CONFIG` to a JSON-encoded `OpenAILLMApiOptions` object to select this transport. The bootstrap passes it directly to the factory. Inference cancellation is forwarded to the HTTP request.

Server tests and Electron E2Es share `LLMDriver` from `@get-halo/workspace-server/testing`. The driver hosts an OpenAI-compatible HTTP endpoint on a random loopback port. Server tests inject `createOpenAILLMApi(llm.configuration)`; Electron E2Es pass the same configuration to the independent workspace server through its launch environment. Both use Pi's real HTTP inference client.

The `llm` fixture survives server and Electron restarts. `llm.respond(m.assistant(...))` answers the next request; tool calls and `m.error(...)` use the same API in both suites. Response callbacks receive OpenAI Chat Completions requests. `llm.waitForRequest()` waits for a pending request without answering it, allowing tests to exercise other actions during inference. Neither suite injects session history or tool results through the model driver.
