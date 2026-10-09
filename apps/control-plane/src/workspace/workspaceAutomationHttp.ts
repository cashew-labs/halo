import type { IncomingMessage, ServerResponse } from "node:http";
import getRawBody from "raw-body";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import { WorkspaceAuthenticationRequiredError } from "../auth/AuthService.js";
import type { WorkspaceService } from "./WorkspaceService.js";
import type { AutomationScheduleCoordinator } from "./AutomationScheduleCoordinator.js";

const snapshotSchema = Type.Object(
  {
    automations: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 128 }),
          nextRunAt: Type.String(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1000 },
    ),
  },
  { additionalProperties: false },
);

class AutomationSnapshotError extends errore.createTaggedError({
  name: "AutomationSnapshotError",
  message: "Invalid workspace automation snapshot",
}) {}

export async function serveWorkspaceAutomationSnapshot(
  request: IncomingMessage,
  response: ServerResponse,
  workspace: WorkspaceService,
  coordinator: AutomationScheduleCoordinator,
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
    limit: 256 * 1024,
    encoding: "utf8",
  }).catch((cause) => new AutomationSnapshotError({ cause }));
  if (raw instanceof Error) {
    response.writeHead(400).end();
    return;
  }
  const snapshot = errore.try({
    // SAFETY: The schema validates the parsed value before it is used.
    try: () => JSON.parse(raw) as Static<typeof snapshotSchema>,
    catch: (cause) => new AutomationSnapshotError({ cause }),
  });
  if (
    snapshot instanceof Error ||
    !Value.Check(snapshotSchema, snapshot) ||
    snapshot.automations.some(
      (routine) => !Number.isFinite(Date.parse(routine.nextRunAt)),
    )
  ) {
    response.writeHead(400).end();
    return;
  }
  const updated = await coordinator.update(identity.workspaceId, snapshot);
  if (updated instanceof Error) {
    console.error(updated);
    response.writeHead(503).end();
    return;
  }
  response.writeHead(204).end();
}
