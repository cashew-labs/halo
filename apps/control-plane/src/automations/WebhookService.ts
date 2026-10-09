import crypto from "node:crypto";
import * as errore from "errore";
import type { AutomationWebhookAccess } from "@get-halo/client";
import type { CredentialService } from "../credentials/CredentialService.js";
import {
  AutomationRegistrationError,
  registrationActivation,
  type AutomationStore,
  type TriggerRegistration,
} from "./AutomationStore.js";

class WebhookSecretError extends errore.createTaggedError({
  name: "WebhookSecretError",
  message: "Webhook credentials are unavailable",
}) {}
type WebhookKey = {
  webhook_id: string;
  token_hash: string;
  credential_id: string;
};

/** Owns webhook keys. Executor cannot enumerate or address this credential owner namespace. */
export class WebhookService {
  private readonly store: AutomationStore;
  private readonly credentials: CredentialService | undefined;
  private readonly origin: string;
  constructor(ctx: {
    store: AutomationStore;
    credentials?: CredentialService;
    origin: string;
  }) {
    this.store = ctx.store;
    this.credentials = ctx.credentials;
    this.origin = ctx.origin;
  }
  async initialize() {
    const created = await this.store.database.query(
      "CREATE TABLE IF NOT EXISTS automation_webhook_keys (webhook_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, credential_id TEXT NOT NULL)",
    );
    if (created instanceof Error) return created;
  }
  endpoint(registration: TriggerRegistration) {
    return new URL(`/api/webhooks/${registration.webhook_id}`, this.origin)
      .href;
  }

  async access(registration: TriggerRegistration, rotate = false) {
    const credentials = this.credentials;
    if (credentials === undefined) return new WebhookSecretError();
    const owner = `automation-webhooks/${registration.owner_id}`;
    const result = await this.store.database.transaction(async (sql) => {
      const rows = await sql.query<TriggerRegistration>(
        `SELECT * FROM automation_registrations WHERE workspace_id = $1 AND automation_id = $2${sql.lock}`,
        [registration.workspace_id, registration.automation_id],
      );
      if (rows instanceof Error) return rows;
      const current = rows[0];
      if (current === undefined || current.deleted === 1)
        return new AutomationRegistrationError({
          reason: "Automation no longer exists",
        });
      const activation = registrationActivation(current);
      if (activation instanceof Error) return activation;
      if (activation.trigger.type !== "webhook")
        return new AutomationRegistrationError({
          reason: "Automation is not a webhook",
        });
      const keys = await sql.query<WebhookKey>(
        "SELECT * FROM automation_webhook_keys WHERE webhook_id = $1",
        [current.webhook_id],
      );
      if (keys instanceof Error) return keys;
      const previous = keys[0];
      if (previous !== undefined && !rotate) {
        const token = await credentials.get(owner, previous.credential_id);
        if (token instanceof Error) return token;
        if (token === undefined) return new WebhookSecretError();
        return { token, previous: undefined };
      }
      const token = crypto.randomBytes(32).toString("base64url");
      const credentialId = crypto.randomUUID();
      const saved = await credentials.set(owner, credentialId, token);
      if (saved instanceof Error) return saved;
      const updated = await sql.query(
        "INSERT INTO automation_webhook_keys (webhook_id, token_hash, credential_id) VALUES ($1,$2,$3) ON CONFLICT (webhook_id) DO UPDATE SET token_hash = excluded.token_hash, credential_id = excluded.credential_id",
        [current.webhook_id, hash(token), credentialId],
      );
      if (updated instanceof Error) return updated;
      return { token, previous: previous?.credential_id };
    });
    if (result instanceof Error) return result;
    if (result.previous !== undefined) {
      const deleted = await credentials.delete(owner, result.previous);
      if (deleted instanceof Error) console.error(deleted);
    }
    const endpoint = this.endpoint(registration);
    const access: AutomationWebhookAccess = {
      endpoint,
      token: result.token,
      url: `${endpoint}?token=${encodeURIComponent(result.token)}`,
    };
    return access;
  }

  async authenticate(webhookId: string, token: string) {
    const registrations = await this.store.database.query<TriggerRegistration>(
      "SELECT * FROM automation_registrations WHERE webhook_id = $1 AND deleted = 0",
      [webhookId],
    );
    if (registrations instanceof Error) return registrations;
    const registration = registrations[0];
    const keys = await this.store.database.query<WebhookKey>(
      "SELECT * FROM automation_webhook_keys WHERE webhook_id = $1",
      [webhookId],
    );
    if (keys instanceof Error) return keys;
    // Compare fixed-size digests, including for an unknown endpoint.
    const matches = crypto.timingSafeEqual(
      Buffer.from(keys[0]?.token_hash ?? "0".repeat(64), "hex"),
      Buffer.from(hash(token), "hex"),
    );
    if (
      !matches ||
      keys[0] === undefined ||
      registration === undefined ||
      token.length === 0
    )
      return undefined;
    const activation = registrationActivation(registration);
    if (activation instanceof Error) return activation;
    if (activation.trigger.type !== "webhook") return undefined;
    return registration;
  }
}
function hash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
