// oxlint-disable unicorn/no-null -- SQL bindings and rows represent absent values with NULL.
import crypto from "node:crypto";
import * as errore from "errore";
import type {
  AutomationActivation,
  AutomationDelivery,
  AutomationEvent,
  AutomationSnapshot,
  AutomationSourceState,
} from "@get-halo/client";
import {
  AutomationDatabase,
  type AutomationSql,
} from "./AutomationDatabase.js";
import type { DatabaseService } from "../DatabaseService.js";

export class AutomationRegistrationError extends errore.createTaggedError({
  name: "AutomationRegistrationError",
  message: "$reason",
}) {}
export class AutomationCapacityError extends errore.createTaggedError({
  name: "AutomationCapacityError",
  message: "Automation delivery capacity reached; retry later",
}) {}
export class AutomationConflictError extends errore.createTaggedError({
  name: "AutomationConflictError",
  message: "Idempotency key was already used with different content",
}) {}

export type TriggerRegistration = {
  workspace_id: string;
  automation_id: string;
  owner_id: string;
  revision: number;
  name: string;
  activation: string;
  enabled: number;
  deleted: number;
  webhook_id: string;
  source_status: AutomationSourceState["status"];
  source_error: string | null;
};

type DeliveryRow = {
  event_id: string;
  workspace_id: string;
  automation_id: string;
  revision: number;
  source: "webhook" | "gmail";
  occurred_at: string;
  payload: string;
  status: AutomationDelivery["status"];
  error: string | null;
  run_id: string | null;
  created_at: string | number;
  attempts: number;
  lease_token: string | null;
};

export class AutomationStore {
  readonly database: AutomationDatabase;
  constructor(ctx: { db: DatabaseService }) {
    this.database = new AutomationDatabase({ client: ctx.db.automationClient });
  }

  async initialize() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS automation_workspaces (workspace_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, generation BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS automation_registrations (
        workspace_id TEXT NOT NULL, automation_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        revision INTEGER NOT NULL, name TEXT NOT NULL, activation TEXT NOT NULL,
        enabled INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        webhook_id TEXT NOT NULL UNIQUE, source_status TEXT NOT NULL DEFAULT 'pending', source_error TEXT,
        PRIMARY KEY (workspace_id, automation_id))`,
      `CREATE TABLE IF NOT EXISTS automation_deliveries (
        event_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, automation_id TEXT NOT NULL,
        revision INTEGER NOT NULL, source TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', error TEXT, run_id TEXT,
        idempotency_key TEXT, request_hash TEXT NOT NULL, created_at BIGINT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at BIGINT NOT NULL, lease_token TEXT,
        UNIQUE (workspace_id, automation_id, idempotency_key))`,
      `CREATE INDEX IF NOT EXISTS automation_delivery_due ON automation_deliveries(status, next_attempt_at)`,
      `CREATE INDEX IF NOT EXISTS automation_delivery_history ON automation_deliveries(workspace_id, automation_id, created_at)`,
    ];
    for (const statement of statements) {
      const created = await this.database.query(statement);
      if (created instanceof Error) return created;
    }
  }

  async register(input: {
    workspaceId: string;
    ownerUserId: string;
    snapshot: AutomationSnapshot;
  }) {
    return await this.database.transaction(async (sql) => {
      const changed = await sql.query(
        `INSERT INTO automation_workspaces (workspace_id, owner_id, generation) VALUES ($1,$2,$3)
        ON CONFLICT (workspace_id) DO UPDATE SET generation = excluded.generation
        WHERE automation_workspaces.generation < excluded.generation AND automation_workspaces.owner_id = excluded.owner_id
        RETURNING workspace_id`,
        [input.workspaceId, input.ownerUserId, input.snapshot.generation],
      );
      if (changed instanceof Error) return changed;
      if (changed.length === 0) return;
      const removed = await sql.query(
        "UPDATE automation_registrations SET deleted = 1, enabled = 0 WHERE workspace_id = $1",
        [input.workspaceId],
      );
      if (removed instanceof Error) return removed;
      for (const automation of input.snapshot.automations) {
        if (automation.activation.type !== "trigger") continue;
        const saved = await sql.query(
          `INSERT INTO automation_registrations
          (workspace_id, automation_id, owner_id, revision, name, activation, enabled, webhook_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (workspace_id, automation_id) DO UPDATE SET
            revision = excluded.revision, name = excluded.name, activation = excluded.activation,
            enabled = excluded.enabled, deleted = 0,
            source_status = CASE WHEN automation_registrations.revision = excluded.revision THEN automation_registrations.source_status ELSE 'pending' END,
            source_error = CASE WHEN automation_registrations.revision = excluded.revision THEN automation_registrations.source_error ELSE NULL END`,
          [
            input.workspaceId,
            automation.id,
            input.ownerUserId,
            automation.revision,
            automation.name,
            JSON.stringify(automation.activation),
            automation.enabled ? 1 : 0,
            crypto.randomUUID(),
          ],
        );
        if (saved instanceof Error) return saved;
      }
      const cancelled = await sql.query(
        `UPDATE automation_deliveries SET status = 'cancelled', error = 'Automation changed before delivery.'
        WHERE workspace_id = $1 AND status = 'pending' AND EXISTS (
          SELECT 1 FROM automation_registrations AS registration WHERE registration.workspace_id = automation_deliveries.workspace_id
            AND registration.automation_id = automation_deliveries.automation_id
            AND (registration.deleted = 1 OR registration.enabled = 0 OR registration.revision <> automation_deliveries.revision))`,
        [input.workspaceId],
      );
      if (cancelled instanceof Error) return cancelled;
    });
  }

  async registration(input: { workspaceId: string; automationId: string }) {
    const rows = await this.database.query<TriggerRegistration>(
      "SELECT * FROM automation_registrations WHERE workspace_id = $1 AND automation_id = $2 AND deleted = 0",
      [input.workspaceId, input.automationId],
    );
    if (rows instanceof Error) return rows;
    return rows[0];
  }

  async enqueue(input: {
    registration: TriggerRegistration;
    eventId?: string;
    source: "webhook" | "gmail";
    occurredAt?: string;
    payload: AutomationEvent["payload"];
    idempotencyKey?: string;
    requestHash: string;
    rateLimit?: number;
  }) {
    return await this.database.transaction(
      async (sql) => await this.enqueueInTransaction(sql, input),
    );
  }

  // Gmail commits matched deliveries and its cursor within the same transaction.
  async enqueueInTransaction(
    sql: AutomationSql,
    input: {
      registration: TriggerRegistration;
      eventId?: string;
      source: "webhook" | "gmail";
      occurredAt?: string;
      payload: AutomationEvent["payload"];
      idempotencyKey?: string;
      requestHash: string;
      rateLimit?: number;
    },
  ) {
    const registration = input.registration;
    const workspaceLock = await sql.query(
      `SELECT workspace_id FROM automation_workspaces WHERE workspace_id = $1${sql.lock}`,
      [registration.workspace_id],
    );
    if (workspaceLock instanceof Error) return workspaceLock;
    const locked = await sql.query<TriggerRegistration>(
      `SELECT * FROM automation_registrations WHERE workspace_id = $1 AND automation_id = $2${sql.lock}`,
      [registration.workspace_id, registration.automation_id],
    );
    if (locked instanceof Error) return locked;
    const current = locked[0];
    if (
      current === undefined ||
      current.deleted === 1 ||
      current.enabled === 0 ||
      current.revision !== registration.revision
    )
      return new AutomationRegistrationError({
        reason: "Automation is paused or changed",
      });
    const existing = await sql.query<DeliveryRow>(
      `SELECT * FROM automation_deliveries WHERE
      (event_id = $1 OR (workspace_id = $2 AND automation_id = $3 AND idempotency_key = $4))`,
      [
        input.eventId ?? "",
        registration.workspace_id,
        registration.automation_id,
        input.idempotencyKey ?? null,
      ],
    );
    if (existing instanceof Error) return existing;
    if (existing[0] !== undefined) {
      const row = existing[0];
      // Request hash is scoped to source, revision, and validated payload by the ingress service.
      const same = await sql.query<{ request_hash: string }>(
        "SELECT request_hash FROM automation_deliveries WHERE event_id = $1",
        [row.event_id],
      );
      if (same instanceof Error) return same;
      if (same[0]?.request_hash !== input.requestHash)
        return new AutomationConflictError();
      return deliveryFromRow(row);
    }
    const pending = await sql.query<{ count: string | number }>(
      "SELECT count(*) AS count FROM automation_deliveries WHERE workspace_id = $1 AND status = 'pending'",
      [registration.workspace_id],
    );
    if (pending instanceof Error) return pending;
    if (Number(pending[0]?.count) >= 1000) return new AutomationCapacityError();
    const now = Date.now();
    if (input.rateLimit !== undefined) {
      const recent = await sql.query<{ count: string | number }>(
        "SELECT count(*) AS count FROM automation_deliveries WHERE workspace_id = $1 AND automation_id = $2 AND created_at > $3",
        [registration.workspace_id, registration.automation_id, now - 60_000],
      );
      if (recent instanceof Error) return recent;
      if (Number(recent[0]?.count) >= input.rateLimit)
        return new AutomationCapacityError();
    }
    const eventId = input.eventId ?? crypto.randomUUID();
    const inserted = await sql.query<DeliveryRow>(
      `INSERT INTO automation_deliveries
      (event_id, workspace_id, automation_id, revision, source, occurred_at, payload, idempotency_key, request_hash, created_at, next_attempt_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
      [
        eventId,
        registration.workspace_id,
        registration.automation_id,
        registration.revision,
        input.source,
        input.occurredAt ?? new Date(now).toISOString(),
        JSON.stringify(input.payload),
        input.idempotencyKey ?? null,
        input.requestHash,
        now,
      ],
    );
    if (inserted instanceof Error) return inserted;
    return deliveryFromRow(inserted[0]!);
  }

  async claim() {
    return await this.database.transaction(async (sql) => {
      const now = Date.now();
      const rows = await sql.query<DeliveryRow>(
        `SELECT * FROM automation_deliveries WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY created_at LIMIT 1${sql.lock}`,
        [now],
      );
      if (rows instanceof Error) return rows;
      const row = rows[0];
      if (row === undefined) return;
      if (now - Number(row.created_at) > 24 * 60 * 60 * 1000) {
        const expired = await sql.query(
          "UPDATE automation_deliveries SET status = 'failed', error = 'Delivery timed out after 24 hours.' WHERE event_id = $1",
          [row.event_id],
        );
        if (expired instanceof Error) return expired;
        return;
      }
      const leaseToken = crypto.randomUUID();
      const updated = await sql.query(
        "UPDATE automation_deliveries SET attempts = attempts + 1, next_attempt_at = $1, lease_token = $2 WHERE event_id = $3",
        [now + 120_000, leaseToken, row.event_id],
      );
      if (updated instanceof Error) return updated;
      const payload = errore.try({
        // SAFETY: Only validated source ingress writes JSON object payloads here.
        try: () => JSON.parse(row.payload) as AutomationEvent["payload"],
        catch: (cause) =>
          new AutomationRegistrationError({
            reason: "Could not read delivery payload",
            cause,
          }),
      });
      if (payload instanceof Error) return payload;
      const event: AutomationEvent = {
        eventId: row.event_id,
        automationId: row.automation_id,
        revision: row.revision,
        source: row.source,
        occurredAt: row.occurred_at,
        payload,
      };
      return {
        workspaceId: row.workspace_id,
        event,
        leaseToken,
        attempts: row.attempts + 1,
      };
    });
  }

  async settle(input: {
    eventId: string;
    leaseToken: string;
    runId?: string;
    error?: string;
    retryMs?: number;
    cancelled?: boolean;
  }) {
    const updated = await this.database.query(
      `UPDATE automation_deliveries SET status = $1, run_id = $2, error = $3, next_attempt_at = $4, lease_token = NULL WHERE event_id = $5 AND lease_token = $6 AND status = 'pending'`,
      [
        input.cancelled
          ? "cancelled"
          : input.runId === undefined
            ? "pending"
            : "delivered",
        input.runId ?? null,
        input.error ?? null,
        Date.now() + (input.retryMs ?? 30_000),
        input.eventId,
        input.leaseToken,
      ],
    );
    if (updated instanceof Error) return updated;
  }

  async prune() {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return await this.database.transaction(async (sql) => {
      const removed = await sql.query(
        "DELETE FROM automation_deliveries WHERE source = 'webhook' AND status <> 'pending' AND created_at < $1",
        [cutoff],
      );
      if (removed instanceof Error) return removed;
      const obsolete = await sql.query(
        `DELETE FROM automation_deliveries WHERE source = 'gmail' AND status <> 'pending' AND created_at < $1 AND EXISTS (SELECT 1 FROM automation_registrations r WHERE r.workspace_id = automation_deliveries.workspace_id AND r.automation_id = automation_deliveries.automation_id AND (r.deleted = 1 OR r.revision <> automation_deliveries.revision))`,
        [cutoff],
      );
      if (obsolete instanceof Error) return obsolete;
      // Keep Gmail's event IDs as a deduplication ledger, without retaining message payloads.
      const redacted = await sql.query(
        "UPDATE automation_deliveries SET payload = '{}' WHERE source = 'gmail' AND status <> 'pending' AND created_at < $1 AND payload <> '{}'",
        [cutoff],
      );
      if (redacted instanceof Error) return redacted;
    });
  }

  async history(input: { workspaceId: string; automationId: string }) {
    const rows = await this.database.query<DeliveryRow>(
      "SELECT * FROM automation_deliveries WHERE workspace_id = $1 AND automation_id = $2 ORDER BY created_at DESC LIMIT 100",
      [input.workspaceId, input.automationId],
    );
    if (rows instanceof Error) return rows;
    return rows.map(deliveryFromRow);
  }
}

export function registrationActivation(registration: TriggerRegistration) {
  return errore.try({
    // SAFETY: The runtime snapshot endpoint validates activation before persistence.
    try: () =>
      JSON.parse(registration.activation) as Extract<
        AutomationActivation,
        { type: "trigger" }
      >,
    catch: (cause) =>
      new AutomationRegistrationError({
        reason: "Could not read trigger registration",
        cause,
      }),
  });
}

function deliveryFromRow(row: DeliveryRow): AutomationDelivery {
  return {
    eventId: row.event_id,
    automationId: row.automation_id,
    revision: row.revision,
    source: row.source,
    occurredAt: row.occurred_at,
    status: row.status,
    error: row.error ?? undefined,
    runId: row.run_id ?? undefined,
  };
}
