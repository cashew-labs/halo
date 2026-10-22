import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoggerApi } from "@get-halo/logger";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import getRawBody from "raw-body";
import * as errore from "errore";
import { appJsonSchema } from "@get-halo/shared/extensionSharing";
import {
  AppLimitError,
  isAppRequestError,
  type AppService,
} from "./AppService.js";

class AppRuntimeHttpError extends errore.createTaggedError({
  name: "AppRuntimeHttpError",
  message: "App runtime request failed: $detail",
}) {}

const actionPathPattern =
  /^\/api\/app-runtime\/actions\/([a-zA-Z][a-zA-Z0-9_]{0,63})$/;
const actionInputSchema = Type.Object(
  { arguments: Type.Optional(Type.Record(Type.String(), appJsonSchema)) },
  { additionalProperties: false },
);

export function isAppRuntimeRequest(url: URL) {
  return url.pathname.startsWith("/api/app-runtime/");
}

/** Endpoints for app VMs, authenticated only by their own app credential. */
export async function serveAppRuntime(ctx: {
  logger: LoggerApi;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  apps: AppService;
}) {
  const { request, response } = ctx;
  response.setHeader("cache-control", "no-store");
  const action = actionPathPattern.exec(ctx.url.pathname);
  const definition =
    ctx.url.pathname === "/api/app-runtime/definition" &&
    request.method === "GET";
  if (!definition && (action === null || request.method !== "POST")) {
    response.writeHead(404).end();
    return;
  }
  const app = await ctx.apps.authenticateRuntime(request.headers.authorization);
  // coverage-exempt: App database outage; no service mocks in the real control-plane fixture.
  if (app instanceof Error) {
    ctx.logger.error({
      event: "app-runtime-authentication-failed",
      errorType: app.name,
    });
    response.writeHead(500).end();
    return;
  }
  if (app === undefined) {
    response.writeHead(401).end();
    return;
  }
  if (action === null) {
    const runtime = await ctx.apps.runtimeDefinition(app);
    if (runtime instanceof Error) {
      ctx.logger.error({
        event: "app-runtime-definition-failed",
        errorType: runtime.name,
      });
      response.writeHead(500).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(runtime));
    return;
  }
  const raw = await getRawBody(request, {
    length: request.headers["content-length"],
    limit: 65_536,
    encoding: "utf8",
  }).catch((cause: unknown) => {
    request.resume();
    return new AppRuntimeHttpError({ detail: "read request", cause });
  });
  const input =
    raw instanceof Error
      ? raw
      : errore.try({
          // SAFETY: actionInputSchema validates the decoded JSON below.
          try: () => JSON.parse(raw === "" ? "{}" : raw) as unknown,
          catch: (cause) =>
            new AppRuntimeHttpError({ detail: "parse request", cause }),
        });
  if (input instanceof Error || !Value.Check(actionInputSchema, input)) {
    response.writeHead(400).end();
    return;
  }
  const result = await ctx.apps.invokeAction({
    app,
    name: action[1]!,
    arguments: input.arguments,
  });
  if (result instanceof AppLimitError) {
    response.writeHead(429, { "retry-after": "600" }).end();
    return;
  }
  if (result instanceof Error) {
    if (!isAppRequestError(result))
      ctx.logger.error({ event: "app-action-failed" });
    response
      .writeHead(isAppRequestError(result) ? 400 : 500, {
        "content-type": "application/json",
      })
      .end(
        JSON.stringify({
          message: isAppRequestError(result)
            ? result.message
            : "App action failed",
        }),
      );
    return;
  }
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify(result));
}
