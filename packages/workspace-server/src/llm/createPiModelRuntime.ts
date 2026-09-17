import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as errore from "errore";
import type { LLMApi } from "./LLMApi.js";

class PiModelRuntimeError extends errore.createTaggedError({
  name: "PiModelRuntimeError",
  message: "Could not initialize Pi's model runtime",
}) {}

export async function createPiModelRuntime(llmApi: LLMApi) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    // oxlint-disable-next-line unicorn/no-null -- Pi uses null to disable models.json discovery and use an in-memory catalog.
    modelsPath: null,
  }).catch((cause) => new PiModelRuntimeError({ cause }));
  if (runtime instanceof Error) return runtime;
  runtime.registerNativeProvider({
    id: llmApi.model.provider,
    name: llmApi.model.provider,
    // Authentication belongs to LLMApi. Pi still requires a configured auth method.
    auth: { apiKey: { name: "LLMApi", resolve: async () => ({ auth: {} }) } },
    getModels: () => [llmApi.model],
    stream: (_model, context, options) =>
      llmApi.stream(context, {
        signal: options?.signal,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
      }),
    streamSimple: (_model, context, options) => llmApi.stream(context, options),
  });
  return runtime;
}
