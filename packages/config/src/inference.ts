import type { Model } from "@earendil-works/pi-ai";

export const workspaceInferencePath = "/api/workspace-runtime/llm/v1";

// Halo's previous primary model, on infrastructure independent of Together.
export const vertexFallback = {
  model: "google/gemini-3.8-flash",
  url: "https://aiplatform.googleapis.com/v1/projects/halo-relay/locations/global/endpoints/openapi/chat/completions",
  maxTokens: 65_536,
};

// The installed Pi catalog predates this model; retain its published metadata.
export const togetherModel = {
  id: "deepseek-ai/DeepSeek-V4.1-Flash",
  name: "DeepSeek V4.1 Flash",
  provider: "together",
  api: "openai-completions",
  baseUrl: "https://api.together.ai/v1",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1_000_000,
  maxTokens: 384_000,
  cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens",
    thinkingFormat: "together",
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
  },
} satisfies Model<"openai-completions">;
