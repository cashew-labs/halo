import type { IncomingMessage, ServerResponse } from "node:http";
import getRawBody from "raw-body";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import { WorkspaceAuthenticationRequiredError } from "../auth/AuthService.js";
import {
  workspaceUpdateReportSchema,
  type WorkspaceUpdates,
} from "./WorkspaceUpdates.js";

class UpdateRequestError extends errore.createTaggedError({
  name: "UpdateRequestError",
  message: "Could not read workspace update request.",
}) {}
export async function serveWorkspaceUpdate(ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  updates: WorkspaceUpdates;
  token: boolean;
}) {
  const { request, response, updates } = ctx;
  response.setHeader("cache-control", "no-store");
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }
  const headers = new Headers();
  if (request.headers.authorization !== undefined)
    headers.set("authorization", request.headers.authorization);
  const result = await (async () => {
    if (ctx.token) {
      const token = await updates.token(headers);
      return token instanceof Error ? token : { token };
    }
    const raw = await getRawBody(request, {
      limit: 4096,
      encoding: "utf8",
    }).catch((cause) => new UpdateRequestError({ cause }));
    if (raw instanceof Error) return raw;
    const report = errore.try({
      try: () => {
        const parsed: unknown = JSON.parse(raw);
        return Value.Check(workspaceUpdateReportSchema, parsed)
          ? parsed
          : new UpdateRequestError();
      },
      catch: (cause) => new UpdateRequestError({ cause }),
    });
    if (report instanceof Error) return report;
    return await updates.report(headers, report);
  })();
  if (result instanceof WorkspaceAuthenticationRequiredError) {
    response.writeHead(401).end();
    return;
  }
  if (result instanceof UpdateRequestError) {
    response.writeHead(400).end();
    return;
  }
  if (result instanceof Error) {
    console.error(result);
    response.writeHead(500).end();
    return;
  }
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify(result));
}
