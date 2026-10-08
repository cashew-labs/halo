import type { IncomingMessage, ServerResponse } from "node:http";
import { OAuth2Client } from "google-auth-library";
import getRawBody from "raw-body";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import type { GmailService } from "./GmailService.js";

const envelopeSchema = Type.Object({
  message: Type.Object({ data: Type.String({ maxLength: 16_384 }) }),
});
const notificationSchema = Type.Object({
  emailAddress: Type.String({ minLength: 3, maxLength: 320 }),
  historyId: Type.String({ pattern: "^[0-9]+$", maxLength: 40 }),
});
class GmailPushError extends errore.createTaggedError({
  name: "GmailPushError",
  message: "Invalid Gmail push notification",
}) {}

export class GmailPushReceiver {
  private readonly auth: OAuth2Client;
  private readonly gmail: GmailService;
  constructor(ctx: { gmail: GmailService; auth?: OAuth2Client }) {
    this.gmail = ctx.gmail;
    this.auth = ctx.auth ?? new OAuth2Client();
  }
  async serve(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("cache-control", "no-store");
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const config = this.gmail.configuration;
    if (config === undefined) {
      response.writeHead(503).end();
      return;
    }
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      response.writeHead(401).end();
      return;
    }
    const ticket = await this.auth
      .verifyIdToken({ idToken: header.slice(7), audience: config.audience })
      .catch((cause) => new GmailPushError({ cause }));
    if (ticket instanceof Error) {
      response.writeHead(401).end();
      return;
    }
    const identity = ticket.getPayload();
    if (
      identity?.email !== config.serviceAccount ||
      identity.email_verified !== true
    ) {
      response.writeHead(401).end();
      return;
    }
    const raw = await getRawBody(request, {
      limit: 32 * 1024,
      encoding: "utf8",
    }).catch((cause) => new GmailPushError({ cause }));
    if (raw instanceof Error) {
      response.writeHead(400).end();
      return;
    }
    const envelope = errore.try({
      // SAFETY: Checked against envelopeSchema immediately after parsing.
      try: () => JSON.parse(raw) as Static<typeof envelopeSchema>,
      catch: (cause) => new GmailPushError({ cause }),
    });
    if (envelope instanceof Error || !Value.Check(envelopeSchema, envelope)) {
      response.writeHead(400).end();
      return;
    }
    const notification = errore.try({
      // SAFETY: Checked against notificationSchema immediately after decoding.
      try: () =>
        JSON.parse(
          Buffer.from(envelope.message.data, "base64url").toString("utf8"),
        ) as Static<typeof notificationSchema>,
      catch: (cause) => new GmailPushError({ cause }),
    });
    if (
      notification instanceof Error ||
      !Value.Check(notificationSchema, notification)
    ) {
      response.writeHead(400).end();
      return;
    }
    // The email only dirties an already verified mailbox. It never selects an owner or advances a cursor.
    const saved = await this.gmail.store.markDirty(notification.emailAddress);
    if (saved instanceof Error) {
      console.error(saved);
      response.writeHead(503).end();
      return;
    }
    this.gmail.schedule();
    response.writeHead(204).end();
  }
}
