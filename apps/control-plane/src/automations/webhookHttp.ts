import type { AutomationEvent } from "@get-halo/client";
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import getRawBody from "raw-body";
import * as errore from "errore";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AutomationCapacityError,
  AutomationConflictError,
  AutomationRegistrationError,
  type AutomationStore,
} from "./AutomationStore.js";
import type { WebhookService } from "./WebhookService.js";

const bodySchema = Type.Record(Type.String(), Type.Unknown());
class WebhookBodyError extends errore.createTaggedError({
  name: "WebhookBodyError",
  message: "Invalid webhook body",
}) {}

export async function serveWebhook(ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  webhookId: string;
  webhooks: WebhookService;
  store: AutomationStore;
}) {
  const { request, response, url } = ctx;
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : (url.searchParams.get("token") ?? "");
  const registration = await ctx.webhooks.authenticate(ctx.webhookId, token);
  if (registration instanceof Error) {
    console.error(registration);
    response.writeHead(503).end();
    return;
  }
  if (registration === undefined) {
    response.writeHead(401).end();
    return;
  }
  if (registration.enabled === 0) {
    response.writeHead(410).end();
    return;
  }
  if (
    request.headers["content-encoding"] !== undefined &&
    request.headers["content-encoding"] !== "identity"
  ) {
    response.writeHead(415).end();
    return;
  }
  const contentType = request.headers["content-type"]
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== undefined && contentType !== "application/json") {
    response.writeHead(415).end();
    return;
  }
  const raw = await getRawBody(request, {
    limit: 256 * 1024,
    encoding: "utf8",
  }).catch((cause) => new WebhookBodyError({ cause }));
  if (raw instanceof Error) {
    response.writeHead(413).end();
    return;
  }
  const body = errore.try({
    // SAFETY: The JSON object schema is checked immediately after parsing.
    try: () =>
      JSON.parse(raw.trim() === "" ? "{}" : raw) as AutomationEvent["payload"],
    catch: (cause) => new WebhookBodyError({ cause }),
  });
  if (body instanceof Error || !Value.Check(bodySchema, body)) {
    response.writeHead(400).end();
    return;
  }
  const idempotencyKey = request.headers["idempotency-key"];
  if (
    Array.isArray(idempotencyKey) ||
    (idempotencyKey !== undefined &&
      (idempotencyKey.length === 0 || idempotencyKey.length > 200))
  ) {
    response.writeHead(400).end();
    return;
  }
  // Persist only the JSON body. Caller credentials, URL query and headers are never forwarded.
  const requestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(["webhook", registration.revision, body]))
    .digest("hex");
  const receipt = await ctx.store.enqueue({
    registration,
    source: "webhook",
    payload: body,
    idempotencyKey,
    requestHash,
    rateLimit: 60,
  });
  if (receipt instanceof AutomationCapacityError) {
    response.writeHead(429, { "retry-after": "60" }).end();
    return;
  }
  if (receipt instanceof AutomationConflictError) {
    response.writeHead(409).end();
    return;
  }
  if (receipt instanceof AutomationRegistrationError) {
    response.writeHead(410).end();
    return;
  }
  if (receipt instanceof Error) {
    console.error(receipt);
    response.writeHead(503).end();
    return;
  }
  response
    .writeHead(202, { "content-type": "application/json" })
    .end(JSON.stringify(receipt));
}
