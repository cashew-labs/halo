import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export interface LLMApi {
  readonly model: Model<Api>;
  stream(
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
}
