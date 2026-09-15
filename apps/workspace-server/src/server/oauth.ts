import type { IncomingMessage, ServerResponse } from "node:http";
import type { OAuthCompletionTarget } from "../agent/runtime/ConnectionService.js";
import type { HaloContext } from "./router.js";

export async function handleOAuthCallback(options: {
  url: URL;
  request: IncomingMessage;
  response: ServerResponse;
  context: Pick<HaloContext, "connections" | "logger">;
}) {
  if (options.request.method !== "GET") {
    options.response.statusCode = 405;
    options.response.end();
    return;
  }

  const providerError = options.url.searchParams.get("error");
  if (providerError !== null) {
    const state = options.url.searchParams.get("state");
    if (state === null) {
      respondWithError(options.response, "Missing OAuth callback parameters.");
      return;
    }
    const target = options.context.connections.completionTarget(state);
    if (target === undefined) {
      respondWithError(options.response, "Authorization is no longer pending.");
      return;
    }
    const cancelled = await options.context.connections.cancelOAuth(state);
    if (cancelled instanceof Error) {
      options.context.logger.warn({
        event: "oauth-cancel-failed",
        error: cancelled,
      });
    }
    respondForCompletion(
      options.response,
      target,
      "Authorization was not completed.",
    );
    return;
  }

  const state = options.url.searchParams.get("state");
  const code = options.url.searchParams.get("code");
  if (state === null || code === null) {
    respondWithError(options.response, "Missing OAuth callback parameters.");
    return;
  }
  const target = options.context.connections.completionTarget(state);
  if (target === undefined) {
    respondWithError(options.response, "Authorization is no longer pending.");
    return;
  }

  const completed = await options.context.connections.completeOAuth({
    state,
    code,
  });
  if (completed instanceof Error) {
    options.context.logger.warn({
      event: "oauth-callback-failed",
      error: completed,
    });
    respondForCompletion(
      options.response,
      target,
      "Authorization could not be completed.",
    );
    return;
  }

  respondForCompletion(options.response, target, undefined);
}

function respondForCompletion(
  response: ServerResponse,
  target: OAuthCompletionTarget,
  error: string | undefined,
) {
  if (target.completion.kind === "server-redirect") {
    response.writeHead(302, {
      "Cache-Control": "no-store",
      Location: `/#/sessions/${encodeURIComponent(target.sessionId)}`,
      "Referrer-Policy": "no-referrer",
    });
    response.end();
    return;
  }
  if (error !== undefined) {
    respondWithError(response, error);
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(
    '<!doctype html><html><head><meta charset="utf-8"><title>Halo</title></head><body>You can close this tab.</body></html>',
  );
}

function respondWithError(response: ServerResponse, message: string) {
  response.writeHead(400, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(message);
}
