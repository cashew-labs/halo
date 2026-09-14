import type { IncomingMessage, ServerResponse } from "node:http";
import type { HaloContext } from "./router.js";

export async function handleOAuthCallback(options: {
  url: URL;
  request: IncomingMessage;
  response: ServerResponse;
  context: HaloContext;
}) {
  if (options.request.method !== "GET") {
    options.response.statusCode = 405;
    options.response.end();
    return;
  }

  const providerError = options.url.searchParams.get("error");
  if (providerError !== null) {
    const state = options.url.searchParams.get("state");
    if (state !== null) {
      const cancelled = await options.context.connections.cancelOAuth(state);
      if (cancelled instanceof Error) {
        options.context.logger.warn({
          event: "oauth-cancel-failed",
          error: cancelled,
        });
      }
    }
    options.response.statusCode = 400;
    options.response.end("Authorization was not completed.");
    return;
  }

  const state = options.url.searchParams.get("state");
  const code = options.url.searchParams.get("code");
  if (state === null || code === null) {
    options.response.statusCode = 400;
    options.response.end("Missing OAuth callback parameters.");
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
    options.response.statusCode = 400;
    options.response.end("Authorization could not be completed.");
    return;
  }

  options.response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
  });
  options.response.end(
    '<!doctype html><html><head><meta charset="utf-8"><title>Halo</title></head><body>You can close this tab.</body></html>',
  );
}
