import {
  createModels,
  createProvider,
  type Models,
} from "@earendil-works/pi-ai";
import type { LLMApi } from "./LLMApi.js";

export function createPiModelRuntime(llmApi: LLMApi): Models {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: llmApi.model.provider,
      name: llmApi.model.provider,
      // Authentication belongs to LLMApi. Pi still requires a configured auth method.
      auth: {
        apiKey: { name: "LLMApi", resolve: async () => ({ auth: {} }) },
      },
      models: [llmApi.model],
      api: {
        stream: (_model, context, options) =>
          llmApi.stream(context, {
            signal: options?.signal,
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
          }),
        streamSimple: (_model, context, options) =>
          llmApi.stream(context, options),
      },
    }),
  );
  return models;
}
