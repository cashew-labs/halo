import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { togetherModel } from "@get-halo/config/inference";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import getRawBody from "raw-body";
import { createProxyServer } from "httpxy";
import * as errore from "errore";
import { WorkspaceAuthenticationRequiredError } from "../auth/AuthService.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";

const maxRequestBytes = 16 * 1024 * 1024;
const inferenceProxy = createProxyServer();
inferenceProxy.on("proxyRes", (upstream) => {
  // Only expose the provider's content type; keep cookies and other headers private.
  upstream.headers = {
    "content-type": upstream.headers["content-type"] ?? "application/json",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  };
});
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

/** Transport for the workspace's existing OpenAI-compatible LLMApi. */
export async function serveWorkspaceInference(ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  workspace: WorkspaceService;
  apiKey: string | undefined;
}) {
  const { request, response, workspace, apiKey } = ctx;
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
  if (apiKey === undefined) {
    response.writeHead(503).end();
    return;
  }

  if (response.destroyed) return;
  // Replace all incoming headers so workspace credentials never reach Together.
  request.headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(raw)),
  };
  const forwarded = await inferenceProxy
    .web(request, response, {
      target: `${togetherModel.baseUrl}/chat/completions`,
      ignorePath: true,
      changeOrigin: true,
      xfwd: false,
      followRedirects: false,
      buffer: Readable.from([raw]),
    })
    .catch(
      (cause) =>
        new WorkspaceInferenceError({ detail: "proxy Together stream", cause }),
    );
  if (!(forwarded instanceof Error) || response.destroyed) return;
  console.error(forwarded);
  if (!response.headersSent) response.writeHead(502).end();
  else response.destroy();
}
