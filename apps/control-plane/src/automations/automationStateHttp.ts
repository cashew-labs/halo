import type { IncomingMessage, ServerResponse } from "node:http";
import type { AutomationSourceState } from "@get-halo/client";
import { WorkspaceAuthenticationRequiredError } from "../auth/AuthService.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import {
  registrationActivation,
  type AutomationStore,
} from "./AutomationStore.js";

export async function serveAutomationState(ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  automationId: string;
  workspace: WorkspaceService;
  store: AutomationStore;
}) {
  const { request, response } = ctx;
  response.setHeader("cache-control", "no-store");
  if (request.method !== "GET") {
    response.writeHead(405, { allow: "GET" }).end();
    return;
  }
  const identity = await ctx.workspace.authenticateRuntimeOwner(
    new Headers({ authorization: request.headers.authorization ?? "" }),
  );
  if (identity instanceof WorkspaceAuthenticationRequiredError) {
    response.writeHead(401).end();
    return;
  }
  if (identity instanceof Error) {
    console.error(identity);
    response.writeHead(503).end();
    return;
  }
  const registration = await ctx.store.registration({
    workspaceId: identity.workspaceId,
    automationId: ctx.automationId,
  });
  if (registration instanceof Error) {
    console.error(registration);
    response.writeHead(503).end();
    return;
  }
  if (registration === undefined) {
    response.writeHead(404).end();
    return;
  }
  const activation = registrationActivation(registration);
  if (activation instanceof Error) {
    console.error(activation);
    response.writeHead(503).end();
    return;
  }
  const deliveries = await ctx.store.history({
    workspaceId: identity.workspaceId,
    automationId: ctx.automationId,
  });
  if (deliveries instanceof Error) {
    console.error(deliveries);
    response.writeHead(503).end();
    return;
  }
  const state: AutomationSourceState = {
    automationId: registration.automation_id,
    revision: registration.revision,
    kind: activation.trigger.type,
    status: registration.enabled === 0 ? "paused" : registration.source_status,
    detail: registration.source_error ?? undefined,
    deliveries,
  };
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify(state));
}
