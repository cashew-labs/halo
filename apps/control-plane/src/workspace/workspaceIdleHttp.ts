import type { IncomingMessage, ServerResponse } from "node:http";
import getRawBody from "raw-body";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import { WorkspaceAuthenticationRequiredError } from "../auth/AuthService.js";
import type { WorkspaceService } from "./WorkspaceService.js";

const reportSchema = Type.Object(
  { idle: Type.Boolean() },
  { additionalProperties: false },
);
class IdleReportError extends errore.createTaggedError({
  name: "IdleReportError",
  message: "Invalid workspace idle report",
}) {}

export async function serveWorkspaceIdleReport(
  request: IncomingMessage,
  response: ServerResponse,
  workspace: WorkspaceService,
) {
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
  const raw = await getRawBody(request, {
    limit: 1024,
    encoding: "utf8",
  }).catch((cause) => new IdleReportError({ cause }));
  if (raw instanceof Error) {
    response.writeHead(400).end();
    return;
  }
  const report = errore.try({
    // SAFETY: reportSchema validates the parsed JSON before its fields are used.
    try: () => JSON.parse(raw) as Static<typeof reportSchema>,
    catch: (cause) => new IdleReportError({ cause }),
  });
  if (report instanceof Error || !Value.Check(reportSchema, report)) {
    response.writeHead(400).end();
    return;
  }
  const saved = await workspace.reportIdle(headers, report.idle);
  if (saved instanceof WorkspaceAuthenticationRequiredError) {
    response.writeHead(401).end();
    return;
  }
  if (saved instanceof Error) {
    console.error(saved);
    response.writeHead(500).end();
    return;
  }
  response.writeHead(204).end();
}
