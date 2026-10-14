import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { togetherModel } from "@get-halo/config/inference";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import getRawBody from "raw-body";
import * as errore from "errore";
import { WorkspaceAuthenticationRequiredError } from "../auth/AuthService.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";

const maxRequestBytes = 16 * 1024 * 1024;
const completionSchema = Type.Object({
  model: Type.Literal(togetherModel.id),
  messages: Type.Array(Type.Unknown(), { minItems: 1 }),
  stream: Type.Literal(true),
  max_tokens: Type.Optional(
    Type.Integer({ minimum: 1, maximum: togetherModel.maxTokens }),
  ),
  max_completion_tokens: Type.Optional(
    Type.Integer({ minimum: 1, maximum: togetherModel.maxTokens }),
  ),
});

class WorkspaceInferenceError extends errore.createTaggedError({
  name: "WorkspaceInferenceError",
  message: "Workspace inference failed: $detail",
}) {}

class InferenceDisconnectedError extends errore.createTaggedError({
  name: "InferenceDisconnectedError",
  message: "Workspace inference client disconnected",
  extends: errore.AbortError,
}) {}

export type CompletionRequest = Omit<
  Static<typeof completionSchema>,
  "model"
> & {
  model: string;
  reasoning?: unknown;
  reasoning_effort?: string;
};

/** The host owns provider endpoints, credentials, and protocol adaptation. */
type InferenceProvider = {
  name: string;
  url: string;
  headers(): Promise<Headers | Error>;
  prepare(body: CompletionRequest): CompletionRequest;
};

export type WorkspaceInference = {
  primary: InferenceProvider;
  fallback: InferenceProvider;
};

/** Transport for the workspace's existing OpenAI-compatible LLMApi. */
export async function serveWorkspaceInference(ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  workspace: WorkspaceService;
  inference: WorkspaceInference | undefined;
}) {
  const { request, response, workspace, inference } = ctx;
  response.setHeader("cache-control", "no-store");
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const headers = new Headers();
  if (request.headers.authorization !== undefined)
    headers.set("authorization", request.headers.authorization);
  const identity = await workspace.authenticateRuntime(headers);
  if (identity instanceof WorkspaceAuthenticationRequiredError) {
    response.writeHead(401).end();
    return;
  }
  if (identity instanceof Error) {
    console.error(identity);
    response.writeHead(500).end();
    return;
  }
  if (
    request.headers["content-type"]?.split(";")[0]?.trim() !==
    "application/json"
  ) {
    response.writeHead(415).end();
    return;
  }
  const raw = await getRawBody(request, {
    length: request.headers["content-length"],
    limit: maxRequestBytes,
    encoding: "utf8",
  }).catch(
    (cause: unknown) =>
      new WorkspaceInferenceError({ detail: "read request", cause }),
  );
  if (raw instanceof Error) {
    const cause = raw.cause;
    const status =
      cause instanceof Error && "status" in cause && cause.status === 413
        ? 413
        : 400;
    // raw-body pauses on failure; drain without retaining the oversized request.
    request.resume();
    response.writeHead(status).end();
    return;
  }
  const body = errore.try({
    // SAFETY: completionSchema validates the untyped JSON below.
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new WorkspaceInferenceError({ detail: "parse request", cause }),
  });
  if (body instanceof Error || !Value.Check(completionSchema, body)) {
    response.writeHead(400).end();
    return;
  }
  if (inference === undefined) {
    response.writeHead(503).end();
    return;
  }

  if (response.destroyed) return;
  using cleanup = new errore.DisposableStack();
  const controller = new AbortController();
  const disconnected = () => controller.abort(new InferenceDisconnectedError());
  response.once("close", disconnected);
  cleanup.defer(() => response.off("close", disconnected));
  const upstream = await requestInference({
    inference,
    body,
    signal: controller.signal,
  });
  if (controller.signal.aborted) return;
  if (upstream instanceof Error) {
    console.error(upstream);
    response.writeHead(502).end();
    return;
  }
  // Provider cookies, credentials, and other headers remain private.
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  if (upstream.body === null) {
    response.end();
    return;
  }
  // Once bytes are visible, a broken stream must fail normally. Switching here
  // could concatenate different answers or duplicate a streamed tool call.
  const forwarded = await pipeline(Readable.from(upstream.body), response, {
    signal: controller.signal,
  }).catch(
    (cause) =>
      new WorkspaceInferenceError({
        detail: "stream provider response",
        cause,
      }),
  );
  if (forwarded === undefined) return;
  if (errore.isAbortError(forwarded)) return;
  console.error(forwarded);
}

async function requestInference(ctx: {
  inference: WorkspaceInference;
  body: CompletionRequest;
  signal: AbortSignal;
}) {
  const { inference, body, signal } = ctx;
  const primary = await requestProvider({
    provider: inference.primary,
    body,
    signal,
  });
  if (signal.aborted) return primary;
  if (
    !(primary instanceof Error) &&
    ![429, 500, 502, 503, 504].includes(primary.status)
  )
    return primary;
  console.warn("Workspace inference fallback", {
    primary: inference.primary.name,
    fallback: inference.fallback.name,
    failure: primary instanceof Error ? primary : primary.status,
  });
  if (!(primary instanceof Error) && primary.body !== null) {
    const cancelled = await primary.body.cancel().catch(
      // coverage-exempt: Best-effort Fetch body cleanup can reject if the stream has already failed; routing and cancellation are tested over real HTTP.
      (cause) =>
        new WorkspaceInferenceError({
          detail: "release failed response",
          cause,
        }),
    );
    if (cancelled instanceof Error) console.warn(cancelled);
  }
  if (signal.aborted) return new InferenceDisconnectedError();
  return await requestProvider({ provider: inference.fallback, body, signal });
}

async function requestProvider(ctx: {
  provider: InferenceProvider;
  body: CompletionRequest;
  signal: AbortSignal;
}) {
  const { provider, body, signal } = ctx;
  const headers = await provider.headers();
  if (headers instanceof Error) return headers;
  headers.set("content-type", "application/json");
  return await fetch(provider.url, {
    method: "POST",
    headers,
    body: JSON.stringify(provider.prepare(body)),
    signal,
    redirect: "error",
  }).catch(
    (cause) =>
      new WorkspaceInferenceError({
        detail: `request ${provider.name}`,
        cause,
      }),
  );
}
