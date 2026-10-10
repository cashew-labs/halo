import type { IncomingMessage, ServerResponse } from "node:http";
import getRawBody from "raw-body";
import {
  automationSnapshotSchema,
  type AutomationSnapshot,
} from "@get-halo/client";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import { WorkspaceAuthenticationRequiredError } from "../auth/AuthService.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import type { AutomationStore } from "./AutomationStore.js";

class AutomationSnapshotError extends errore.createTaggedError({
  name: "AutomationSnapshotError",
  message: "Invalid workspace automation snapshot",
}) {}

export async function serveAutomationSnapshot(
  request: IncomingMessage,
  response: ServerResponse,
  workspace: WorkspaceService,
  store: AutomationStore,
) {
  response.setHeader("cache-control", "no-store");
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const headers = new Headers();
  if (request.headers.authorization !== undefined)
    headers.set("authorization", request.headers.authorization);
  const identity = await workspace.authenticateRuntimeOwner(headers);
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
    limit: 256 * 1024,
    encoding: "utf8",
  }).catch((cause) => new AutomationSnapshotError({ cause }));
  if (raw instanceof Error) {
    response.writeHead(400).end();
    return;
  }
  const snapshot = errore.try({
    // SAFETY: The schema validates the parsed value before it is used.
    try: () => JSON.parse(raw) as AutomationSnapshot,
    catch: (cause) => new AutomationSnapshotError({ cause }),
  });
  if (
    snapshot instanceof Error ||
    !Value.Check(automationSnapshotSchema, snapshot) ||
    new Set(snapshot.automations.map((automation) => automation.id)).size !==
      snapshot.automations.length
  ) {
    response.writeHead(400).end();
    return;
  }
  const updated = await store.register({ ...identity, snapshot });
  if (updated instanceof Error) {
    console.error(updated);
    response.writeHead(503).end();
    return;
  }
  response.writeHead(204).end();
}
