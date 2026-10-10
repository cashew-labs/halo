// oxlint-disable unicorn/no-null -- SQL uses NULL for missing values.
import crypto from "node:crypto";
import * as errore from "errore";
class GmailLeaseError extends errore.createTaggedError({
  name: "GmailLeaseError",
  message: "Gmail mailbox lease expired; delivery was rolled back",
}) {}
import type {
  AutomationStore,
  TriggerRegistration,
} from "./AutomationStore.js";
import type { GmailAccount, GmailMessage } from "./GmailApi.js";
import type { AutomationEvent } from "@get-halo/client";

export type GmailSource = {
  workspace_id: string;
  automation_id: string;
  revision: number;
  email: string;
  baseline: string;
  connection_address: string;
};
export type GmailMailbox = {
  email: string;
  cursor: string;
  expiration: string | null;
  renew_at: string | number;
  next_sync_at: string | number;
  dirty: number;
  lease_token: string | null;
  lease_until: string | number;
  owner_id: string;
  connection_address: string;
  gap: string | null;
};

export class GmailStore {
  private readonly automations: AutomationStore;
  constructor(ctx: { automations: AutomationStore }) {
    this.automations = ctx.automations;
  }
  async initialize() {
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS automation_gmail_setup (workspace_id TEXT NOT NULL, automation_id TEXT NOT NULL, revision INTEGER NOT NULL, retry_at BIGINT NOT NULL, PRIMARY KEY(workspace_id, automation_id))`,
      `CREATE TABLE IF NOT EXISTS automation_gmail_sources (workspace_id TEXT NOT NULL, automation_id TEXT NOT NULL, revision INTEGER NOT NULL, email TEXT NOT NULL, baseline TEXT NOT NULL, connection_address TEXT NOT NULL, PRIMARY KEY(workspace_id, automation_id))`,
      `CREATE TABLE IF NOT EXISTS automation_gmail_mailboxes (email TEXT PRIMARY KEY, cursor TEXT NOT NULL, expiration TEXT, renew_at BIGINT NOT NULL DEFAULT 0, next_sync_at BIGINT NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until BIGINT NOT NULL DEFAULT 0, owner_id TEXT NOT NULL, connection_address TEXT NOT NULL, gap TEXT)`,
    ]) {
      const result = await this.automations.database.query(sql);
      if (result instanceof Error) return result;
    }
  }
  async pending() {
    return await this.automations.database.query<TriggerRegistration>(
      `SELECT r.* FROM automation_registrations r LEFT JOIN automation_gmail_sources s ON s.workspace_id = r.workspace_id AND s.automation_id = r.automation_id AND s.revision = r.revision LEFT JOIN automation_gmail_setup attempts ON attempts.workspace_id = r.workspace_id AND attempts.automation_id = r.automation_id AND attempts.revision = r.revision WHERE r.enabled = 1 AND r.deleted = 0 AND r.activation LIKE '%"type":"gmail"%' AND s.automation_id IS NULL AND (attempts.retry_at IS NULL OR attempts.retry_at <= $1) ORDER BY COALESCE(attempts.retry_at, 0) LIMIT 20`,
      [Date.now()],
    );
  }
  async deferSetup(registration: TriggerRegistration) {
    const saved = await this.automations.database.query(
      "INSERT INTO automation_gmail_setup (workspace_id,automation_id,revision,retry_at) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id,automation_id) DO UPDATE SET revision = excluded.revision, retry_at = excluded.retry_at",
      [
        registration.workspace_id,
        registration.automation_id,
        registration.revision,
        Date.now() + 60_000,
      ],
    );
    if (saved instanceof Error) return saved;
  }
  async source(registration: TriggerRegistration) {
    const rows = await this.automations.database.query<GmailSource>(
      "SELECT * FROM automation_gmail_sources WHERE workspace_id = $1 AND automation_id = $2 AND revision = $3",
      [
        registration.workspace_id,
        registration.automation_id,
        registration.revision,
      ],
    );
    if (rows instanceof Error) return rows;
    return rows[0];
  }
  async bind(
    registration: TriggerRegistration,
    profile: { emailAddress: string; historyId: string },
    connectionAddress: string,
  ) {
    return await this.automations.database.transaction(async (sql) => {
      const rows = await sql.query<TriggerRegistration>(
        `SELECT * FROM automation_registrations WHERE workspace_id = $1 AND automation_id = $2${sql.lock}`,
        [registration.workspace_id, registration.automation_id],
      );
      if (rows instanceof Error) return rows;
      const current = rows[0];
      if (
        current === undefined ||
        current.deleted === 1 ||
        current.enabled === 0 ||
        current.revision !== registration.revision
      )
        return;
      const email = profile.emailAddress.toLowerCase();
      const existingMailbox = await sql.query<GmailMailbox>(
        `SELECT * FROM automation_gmail_mailboxes WHERE email = $1${sql.lock}`,
        [email],
      );
      if (existingMailbox instanceof Error) return existingMailbox;
      // Join between history batches, so an in-flight page cannot skip the new source.
      if (Number(existingMailbox[0]?.lease_until ?? 0) > Date.now()) return;

      const bound = await sql.query(
        `INSERT INTO automation_gmail_sources (workspace_id,automation_id,revision,email,baseline,connection_address) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (workspace_id,automation_id) DO UPDATE SET revision = excluded.revision, email = excluded.email, baseline = excluded.baseline, connection_address = excluded.connection_address WHERE automation_gmail_sources.revision <> excluded.revision`,
        [
          current.workspace_id,
          current.automation_id,
          current.revision,
          email,
          profile.historyId,
          connectionAddress,
        ],
      );
      if (bound instanceof Error) return bound;
      const mailbox = await sql.query(
        `INSERT INTO automation_gmail_mailboxes (email,cursor,owner_id,connection_address) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO UPDATE SET next_sync_at = 0`,
        [email, profile.historyId, current.owner_id, connectionAddress],
      );
      if (mailbox instanceof Error) return mailbox;
    });
  }
  async cleanup() {
    const result = await this.automations.database.query(
      `DELETE FROM automation_gmail_sources WHERE NOT EXISTS (SELECT 1 FROM automation_registrations r WHERE r.workspace_id = automation_gmail_sources.workspace_id AND r.automation_id = automation_gmail_sources.automation_id AND r.revision = automation_gmail_sources.revision AND r.enabled = 1 AND r.deleted = 0)`,
    );
    if (result instanceof Error) return result;
  }
  async markDirty(email: string) {
    const result = await this.automations.database.query(
      "UPDATE automation_gmail_mailboxes SET dirty = dirty + 1, next_sync_at = 0 WHERE email = $1",
      [email.toLowerCase()],
    );
    if (result instanceof Error) return result;
  }
  async mailbox(email: string) {
    const rows = await this.automations.database.query<GmailMailbox>(
      "SELECT * FROM automation_gmail_mailboxes WHERE email = $1",
      [email],
    );
    if (rows instanceof Error) return rows;
    return rows[0];
  }
  async claim() {
    return await this.automations.database.transaction(async (sql) => {
      const now = Date.now();
      const rows = await sql.query<GmailMailbox>(
        `SELECT * FROM automation_gmail_mailboxes WHERE lease_until <= $1 AND (next_sync_at <= $1 OR renew_at <= $1) ORDER BY next_sync_at LIMIT 1${sql.lock}`,
        [now],
      );
      if (rows instanceof Error) return rows;
      if (rows[0] === undefined) return;
      const mailbox = { ...rows[0], lease_token: crypto.randomUUID() };
      const claimed = await sql.query(
        "UPDATE automation_gmail_mailboxes SET lease_token = $1, lease_until = $2 WHERE email = $3",
        [mailbox.lease_token, now + 120_000, mailbox.email],
      );
      if (claimed instanceof Error) return claimed;
      return mailbox;
    });
  }
  async keepLease(mailbox: GmailMailbox) {
    const result = await this.automations.database.query(
      "UPDATE automation_gmail_mailboxes SET lease_until = $1 WHERE email = $2 AND lease_token = $3 AND lease_until > $4 RETURNING email",
      [Date.now() + 120_000, mailbox.email, mailbox.lease_token, Date.now()],
    );
    if (result instanceof Error) return result;
    if (result.length === 0) return new GmailLeaseError();
  }
  async sources(email: string) {
    return await this.automations.database.query<
      GmailSource & TriggerRegistration
    >(
      `SELECT r.*, s.email, s.baseline, s.connection_address FROM automation_gmail_sources s JOIN automation_registrations r ON r.workspace_id = s.workspace_id AND r.automation_id = s.automation_id AND r.revision = s.revision WHERE s.email = $1 AND r.enabled = 1 AND r.deleted = 0`,
      [email],
    );
  }
  async status(
    registration: TriggerRegistration,
    status: TriggerRegistration["source_status"],
    error?: string,
  ) {
    const result = await this.automations.database.query(
      "UPDATE automation_registrations SET source_status = $1, source_error = $2 WHERE workspace_id = $3 AND automation_id = $4 AND revision = $5",
      [
        status,
        error ?? null,
        registration.workspace_id,
        registration.automation_id,
        registration.revision,
      ],
    );
    if (result instanceof Error) return result;
  }
  async renew(
    mailbox: GmailMailbox,
    watch: { expiration: string },
    account: GmailAccount,
  ) {
    const result = await this.automations.database.query(
      "UPDATE automation_gmail_mailboxes SET expiration = $1, renew_at = $2, owner_id = $3, connection_address = $4 WHERE email = $5 AND lease_token = $6",
      [
        watch.expiration,
        Math.min(
          Date.now() +
            20 * 60 * 60 * 1000 +
            crypto.randomInt(4 * 60 * 60 * 1000),
          Number(watch.expiration) - 60 * 60 * 1000,
        ),
        account.ownerId,
        account.connectionAddress,
        mailbox.email,
        mailbox.lease_token,
      ],
    );
    if (result instanceof Error) return result;
  }
  async commitPage(
    mailbox: GmailMailbox,
    cursor: string,
    matches: {
      registration: TriggerRegistration;
      message: GmailMessage;
      payload: AutomationEvent["payload"];
    }[],
    gap?: string,
  ) {
    return await this.automations.database.transaction(async (sql) => {
      // Match enqueue locks workspace/registration first, so keep mailbox locks last
      // consistently with source registration to avoid a cross-worker lock inversion.
      for (const match of matches) {
        const eventId = crypto
          .createHash("sha256")
          .update(
            JSON.stringify([
              match.registration.workspace_id,
              match.registration.automation_id,
              match.registration.revision,
              mailbox.email,
              match.message.id,
            ]),
          )
          .digest("hex");
        const accepted = await this.automations.enqueueInTransaction(sql, {
          registration: match.registration,
          source: "gmail",
          eventId,
          payload: match.payload,
          requestHash: eventId,
        });
        if (accepted instanceof Error) return accepted;
      }
      const updated = await sql.query(
        "UPDATE automation_gmail_mailboxes SET cursor = $1, gap = COALESCE($2, gap), lease_until = $3 WHERE email = $4 AND lease_token = $5 AND lease_until > $6 RETURNING email",
        [
          cursor,
          gap ?? null,
          Date.now() + 120_000,
          mailbox.email,
          mailbox.lease_token,
          Date.now(),
        ],
      );
      if (updated instanceof Error) return updated;
      if (updated.length === 0) return new GmailLeaseError();
    });
  }
  async release(mailbox: GmailMailbox, retryMs = 5 * 60 * 1000) {
    const result = await this.automations.database.query(
      "UPDATE automation_gmail_mailboxes SET next_sync_at = CASE WHEN dirty = $1 THEN $2 ELSE 0 END, renew_at = CASE WHEN renew_at <= $3 THEN $2 ELSE renew_at END, lease_token = NULL, lease_until = 0 WHERE email = $4 AND lease_token = $5",
      [
        mailbox.dirty,
        Date.now() + retryMs,
        Date.now(),
        mailbox.email,
        mailbox.lease_token,
      ],
    );
    if (result instanceof Error) return result;
  }
  async remove(mailbox: GmailMailbox) {
    const result = await this.automations.database.query(
      "DELETE FROM automation_gmail_mailboxes WHERE email = $1 AND lease_token = $2 AND NOT EXISTS (SELECT 1 FROM automation_gmail_sources WHERE email = $1) RETURNING email",
      [mailbox.email, mailbox.lease_token],
    );
    if (result instanceof Error) return result;
    if (result.length === 0) {
      const reset = await this.automations.database.query(
        "UPDATE automation_gmail_mailboxes SET renew_at = 0, expiration = NULL WHERE email = $1 AND lease_token = $2",
        [mailbox.email, mailbox.lease_token],
      );
      if (reset instanceof Error) return reset;
    }
  }
}
