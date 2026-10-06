import type { Model } from "@earendil-works/pi-ai";

export const workspaceInferencePath = "/api/workspace-runtime/llm/v1";

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
