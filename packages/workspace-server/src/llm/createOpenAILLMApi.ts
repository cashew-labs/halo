import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { LLMApi } from "./LLMApi.js";

export type OpenAILLMApiOptions = {
  model: Model<"openai-completions">;
  apiKey: string;
  reasoning?: ThinkingLevel;
};

export function createOpenAILLMApi(options: OpenAILLMApiOptions): LLMApi {
  return {
    model: options.model,
    stream: (context, streamOptions) =>
      streamSimple(options.model, context, {
        ...streamOptions,
        reasoning: streamOptions?.reasoning ?? options.reasoning,
        apiKey: options.apiKey,
      }),
  };
}
