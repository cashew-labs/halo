# Inference dependency

`WorkspaceServer.start({ config, host })` requires an `LLMApi` on `host`. Each
session creates an in-memory Pi `ModelRuntime` backed by that shared API through
its own trace recorder. This keeps concurrent model calls associated with the
correct conversation. Sessions do not discover providers, select a default
model, or load model credentials.

`LLMApi` exposes the assigned model's metadata and `stream(context, options)`, using Pi's existing message and event types. The implementation owns inference transport and authentication. Forward cancellation through `options.signal`. Halo continues to own tools, conversation state, and persistence. There is no model-selection or model-list API yet.

Without `HALO_LLM_CONFIG`, the standalone workspace-server bootstrap uses `createPiLLMApi({ agentDir, provider, modelId })` in both development and production. This temporary backend uses local Pi credentials and the workspace's `models.json`; the model is selected explicitly by the bootstrap. It is the only layer that should discover local inference configuration. The adapter above `LLMApi` uses in-memory Pi configuration and does not read those files.

When a control-plane inference service is available, its client can implement `LLMApi` and be supplied by the VM bootstrap. It should obtain the assigned model from the control plane and send inference there; authorization must be enforced by the control plane on each request. No control-plane transport is implemented here.

`createOpenAILLMApi({ model, apiKey })` implements `LLMApi` using Pi's OpenAI Chat Completions client. The supplied model includes `baseUrl` and its capabilities and limits. Server hosts can set `HALO_LLM_CONFIG` to a JSON-encoded `OpenAILLMApiOptions` object to select this transport. The bootstrap passes it directly to the factory. Inference cancellation is forwarded to the HTTP request.

Server tests and Electron E2Es share `LLMDriver` from `@get-halo/workspace-server/testing`. The driver hosts an OpenAI-compatible HTTP endpoint on a random loopback port. Server tests inject `createOpenAILLMApi(llm.configuration)`; Electron E2Es pass the same configuration to the independent workspace server through its launch environment. Both use Pi's real HTTP inference client.

The `llm` fixture survives server and Electron restarts. `llm.respond(m.assistant(...))` answers the next request; tool calls and `m.error(...)` use the same API in both suites. Response callbacks receive OpenAI Chat Completions requests. `llm.waitForRequest()` waits for a pending request without answering it, allowing tests to exercise other actions during inference. Neither suite injects session history or tool results through the model driver.
