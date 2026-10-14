import { GoogleAuth } from "google-auth-library";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { togetherModel, vertexFallback } from "@get-halo/config/inference";
import * as errore from "errore";
import type {
  CompletionRequest,
  WorkspaceInference,
} from "./workspaceInference.js";

class VertexAuthenticationError extends errore.createTaggedError({
  name: "VertexAuthenticationError",
  message: "Could not authenticate Gemini fallback",
}) {}

const assistantToolsSchema = Type.Object({
  role: Type.Literal("assistant"),
  tool_calls: Type.Array(
    Type.Object({
      extra_content: Type.Optional(
        Type.Object({
          google: Type.Optional(
            Type.Object({ thought_signature: Type.Optional(Type.String()) }),
          ),
        }),
      ),
    }),
  ),
});

export function createWorkspaceInference(ctx: {
  apiKey: string;
  auth: GoogleAuth;
}): WorkspaceInference {
  return {
    primary: {
      name: togetherModel.id,
      url: `${togetherModel.baseUrl}/chat/completions`,
      headers: async () =>
        new Headers({ authorization: `Bearer ${ctx.apiKey}` }),
      prepare: (body) => body,
    },
    fallback: {
      name: vertexFallback.model,
      url: vertexFallback.url,
      headers: async () =>
        await ctx.auth
          .getRequestHeaders(vertexFallback.url)
          .catch((cause) => new VertexAuthenticationError({ cause })),
      prepare: prepareVertexRequest,
    },
  };
}

function prepareVertexRequest(body: CompletionRequest) {
  const request: CompletionRequest = {
    ...body,
    model: vertexFallback.model,
    max_tokens: Math.min(
      body.max_completion_tokens ?? body.max_tokens ?? vertexFallback.maxTokens,
      vertexFallback.maxTokens,
    ),
    reasoning_effort: "low",
    messages: body.messages.map((message) => {
      if (!Value.Check(assistantToolsSchema, message)) return message;
      return {
        ...message,
        tool_calls: message.tool_calls.map((call) => ({
          ...call,
          extra_content: {
            ...call.extra_content,
            google: {
              ...call.extra_content?.google,
              // Imported DeepSeek history and the OpenAI transport have no
              // Gemini signatures. Google documents this sentinel for that case:
              // https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures
              thought_signature:
                call.extra_content?.google?.thought_signature ??
                "skip_thought_signature_validator",
            },
          },
        })),
      };
    }),
  };
  delete request.max_completion_tokens;
  delete request.reasoning;
  return request;
}
