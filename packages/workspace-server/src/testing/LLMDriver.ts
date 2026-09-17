import http from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter, once } from "node:events";
import { text } from "node:stream/consumers";
import crypto from "node:crypto";
import type { OpenAILLMApiOptions } from "../llm/createOpenAILLMApi.js";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import * as errore from "errore";
import type { MessageDialect } from "@get-halo/shared/testing";

type ModelResponse =
  | ReturnType<MessageDialect["assistant"]>
  | ReturnType<MessageDialect["tool"]["start"]>;
type ResponseDescription =
  | ModelResponse
  | ModelResponse[]
  | ReturnType<MessageDialect["error"]>;
type Responder = (
  request: ChatCompletionCreateParamsStreaming,
) => ResponseDescription | Promise<ResponseDescription>;
type PendingRequest = {
  body: ChatCompletionCreateParamsStreaming;
  response: http.ServerResponse;
};

class LLMEndpointError extends errore.createTaggedError({
  name: "LLMEndpointError",
  message: "Scripted LLM endpoint failed: $operation",
}) {}

export class LLMDriver {
  private readonly pending: PendingRequest[] = [];
  private readonly incoming = new EventEmitter();

  private constructor(private readonly server: http.Server) {}

  static async start() {
    const server = http.createServer();
    const llm = new LLMDriver(server);
    server.on("request", async (request, response) => {
      const received = await llm.receive(request, response);
      if (received instanceof Error) {
        console.error(received);
        response.writeHead(500).end();
      }
    });
    server.listen({ host: "127.0.0.1", port: 0 });
    const listening = await once(server, "listening").catch(
      (cause) => new LLMEndpointError({ operation: "listen", cause }),
    );
    if (listening instanceof Error) return listening;
    return llm;
  }

  get configuration(): OpenAILLMApiOptions {
    // SAFETY: start() awaits listening on a TCP port before exposing this instance.
    const address = this.server.address() as AddressInfo;
    return {
      apiKey: "halo-e2e",
      model: {
        id: "scripted",
        name: "Scripted LLM",
        api: "openai-completions",
        provider: "halo-scripted",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    };
  }

  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error !== undefined) return reject(error);
        resolve();
      });
    });
  }

  async respond(description: ResponseDescription | Responder) {
    await this.waitForRequest();
    const request = this.pending.shift()!;
    const result =
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The API accepts a statically typed description or callback.
      typeof description === "function"
        ? await description(request.body)
        : description;
    if (request.response.destroyed) {
      throw new LLMEndpointError({ operation: "request was canceled" });
    }
    sendResponse(request, result);
  }

  async stream() {
    await this.waitForRequest();
    return startResponse(this.pending.shift()!);
  }

  private async receive(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const raw = await text(request).catch(
      (cause) => new LLMEndpointError({ operation: "read request", cause }),
    );
    if (raw instanceof Error) return raw;
    const body = errore.try({
      // SAFETY: This test endpoint receives Chat Completions requests from Pi's OpenAI client.
      try: () => JSON.parse(raw) as ChatCompletionCreateParamsStreaming,
      catch: (cause) =>
        new LLMEndpointError({ operation: "parse request", cause }),
    });
    if (body instanceof Error) return body;
    if (response.destroyed) return;
    const pending = { body, response };
    this.pending.push(pending);
    response.once("close", () => {
      const index = this.pending.indexOf(pending);
      if (index !== -1) this.pending.splice(index, 1);
    });
    this.incoming.emit("request");
  }

  async waitForRequest() {
    while (this.pending.length === 0) {
      const received = await once(this.incoming, "request", {
        signal: AbortSignal.timeout(10_000),
      }).catch(
        (cause) =>
          new LLMEndpointError({
            operation: "wait for request within 10 seconds",
            cause,
          }),
      );
      if (received instanceof Error) throw received;
    }
  }
}

function sendResponse(
  { body, response }: PendingRequest,
  description: ResponseDescription,
) {
  if (!Array.isArray(description) && description.type === "error") {
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: description.message, type: "permission_error" },
      }),
    );
    return;
  }
  const streamed = startResponse({ body, response });
  const items = Array.isArray(description) ? description : [description];
  for (const item of items) streamed.write(item);
  streamed.end();
}

function startResponse({ body, response }: PendingRequest) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (choice: ChatCompletionChunk.Choice) => {
    const data: ChatCompletionChunk = {
      id,
      created,
      object: "chat.completion.chunk",
      model: body.model,
      choices: [choice],
    };
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const delta = (value: ChatCompletionChunk.Choice.Delta) =>
    // oxlint-disable-next-line unicorn/no-null -- OpenAI streaming chunks use a null finish_reason until completion.
    chunk({ index: 0, delta: value, finish_reason: null });
  delta({ role: "assistant" });
  let toolIndex = 0;
  return {
    write(item: ModelResponse) {
      if (item.type === "assistant") {
        delta({ content: item.text });
        return;
      }
      delta({
        tool_calls: [
          {
            index: toolIndex++,
            id: item.id,
            type: "function",
            function: {
              name: item.path,
              arguments: JSON.stringify(
                item.arguments === undefined ? {} : item.arguments,
              ),
            },
          },
        ],
      });
    },
    end() {
      chunk({
        index: 0,
        delta: {},
        finish_reason: toolIndex > 0 ? "tool_calls" : "stop",
      });
      response.end("data: [DONE]\n\n");
    },
  };
}

export function messageText(message: ChatCompletionMessageParam): string {
  if (message.content === null || message.content === undefined) return "";
  if (!Array.isArray(message.content)) return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
