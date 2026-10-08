import type { GmailService } from "./GmailService.js";
import type { WebhookService } from "./WebhookService.js";
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
  webhooks: WebhookService;
  gmail: GmailService;
  secretAction?: string;
}) {
  const { request, response } = ctx;
  response.setHeader("cache-control", "no-store");
  const method = ctx.secretAction === undefined ? "GET" : "POST";
  if (request.method !== method) {
    response.writeHead(405, { allow: method }).end();
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
  const access =
    activation.trigger.type === "webhook"
      ? await ctx.webhooks.access(registration, ctx.secretAction === "rotate")
      : undefined;
  if (ctx.secretAction !== undefined) {
    if (access === undefined) {
      response.writeHead(400).end();
      return;
    }
    if (access instanceof Error) {
      console.error(access);
      response.writeHead(503).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(access));
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
  const gmailState =
    activation.trigger.type === "gmail"
      ? await ctx.gmail.state(registration)
      : undefined;
  if (gmailState instanceof Error) {
    console.error(gmailState);
    response.writeHead(503).end();
    return;
  }
  const state: AutomationSourceState = {
    automationId: registration.automation_id,
    revision: registration.revision,
    kind: activation.trigger.type,
    status:
      registration.enabled === 0
        ? "paused"
        : access instanceof Error
          ? "needsAttention"
          : access !== undefined
            ? "active"
            : registration.source_status,
    detail:
      access instanceof Error
        ? access.message
        : (registration.source_error ?? undefined),
    endpoint:
      activation.trigger.type === "webhook"
        ? ctx.webhooks.endpoint(registration)
        : undefined,
    ...gmailState,
    deliveries,
  };
  if (registration.enabled === 0) state.status = "paused";
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify(state));
}
