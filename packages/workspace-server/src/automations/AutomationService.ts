// oxlint-disable unicorn/no-null -- SQL rows and bindings use null for NULL.
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { Cron } from "croner";
import * as errore from "errore";
import {
  automationEventSchema,
  type AutomationEvent,
  automationActionSchema,
  automationActivationSchema,
  type AutomationActivation,
  automationInputSchema,
  InvalidAutomationError,
  type Automation,
  type AutomationAction,
  type AutomationInput,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationRunTrigger,
} from "@get-halo/client";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import { Stream } from "@get-halo/shared/Stream";
import type { DatabaseClient } from "../storage/DatabaseClient.js";

export class AutomationNotFoundError extends errore.createTaggedError({
  name: "AutomationNotFoundError",
  message:
    "Automation '$automationId' does not exist. List automations to find its ID.",
}) {}

type AutomationRow = {
  id: string;
  extension_id: string | null;
  name: string;
  activation: string;
  revision: number;
  action: string;
  enabled: number;
  auto_archive_thread: number;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
};

type AutomationRunRow = {
  id: string;
  automation_id: string;
  revision: number;
  event_id: string | null;
  trigger: AutomationRunTrigger;
  scheduled_for: number;
  thread_id: string | null;
  status: AutomationRunStatus;
  started_at: number;
  finished_at: number | null;
  error: string | null;
  snapshot: string | null;
  payload: string | null;
};

const extensionIdPattern = /^[a-z][a-z0-9-]*$/;

export class AutomationService {
  // Committed automations with their latest run; one queue orders writes and initial subscriptions.
  private automations: Automation[];
  private readonly changes = new Stream<Automation[]>();
  private readonly actionQueue = new SerialQueue();
  private readonly database: DatabaseClient;

  private constructor(ctx: {
    database: DatabaseClient;
    automations: Automation[];
  }) {
    this.database = ctx.database;
    this.automations = ctx.automations;
  }

  static async open(ctx: { database: DatabaseClient }) {
    const stored = await ctx.database.access((connection) => {
      // SAFETY: The projection matches the halo_automations table.
      const automations = connection
        .prepare("SELECT * FROM halo_automations ORDER BY created_at, id")
        .all() as AutomationRow[];
      // SAFETY: The projection matches the halo_automation_runs table.
      const lastRuns = connection
        .prepare(
          `SELECT * FROM halo_automation_runs AS run
           WHERE run.id = (
             SELECT latest.id FROM halo_automation_runs AS latest
             WHERE latest.automation_id = run.automation_id AND latest.status != 'skipped'
             ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1
           )`,
        )
        .all() as AutomationRunRow[];
      return { automations, lastRuns };
    });
    if (stored instanceof Error) return stored;
    const lastRuns = new Map(
      stored.lastRuns.map((row) => [row.automation_id, runFromRow(row)]),
    );
    const automations: Automation[] = [];
    for (const row of stored.automations) {
      const automation = automationFromRow(row, lastRuns.get(row.id));
      if (automation instanceof Error) return automation;
      automations.push(automation);
    }
    return new AutomationService({ database: ctx.database, automations });
  }

  list() {
    return this.automations;
  }

  get(automationId: string) {
    return (
      this.automations.find((automation) => automation.id === automationId) ??
      new AutomationNotFoundError({ automationId })
    );
  }

  subscribe(listener: (automations: Automation[]) => void) {
    return this.changes.subscribe(listener);
  }

  async *watch(signal: AbortSignal | undefined) {
    const initial = await this.actionQueue.run(() => ({
      automations: this.automations,
      updates: this.changes.consume({ abortSignal: signal }),
    }));
    using updates = initial.updates;
    if (signal?.aborted) return;
    yield initial.automations;
    yield* updates;
  }

  async save(input: AutomationInput) {
    const valid = validateInput(input);
    if (valid instanceof Error) return valid;
    return await this.actionQueue.run(async () => {
      const existing = this.automations.find(
        (automation) => automation.id === input.id,
      );
      if (input.id !== undefined && existing === undefined)
        return new AutomationNotFoundError({ automationId: input.id });
      const now = Date.now();
      const enabled = input.enabled ?? existing?.enabled ?? true;
      const autoArchiveSession =
        input.autoArchiveSession ?? existing?.autoArchiveSession ?? false;
      const nextRunAt = enabled
        ? nextActivation({ activation: valid.activation, after: now })
        : undefined;
      if (nextRunAt instanceof Error) return nextRunAt;
      const automation: Automation = {
        id: existing?.id ?? randomUUID(),
        revision: (existing?.revision ?? 0) + 1,
        ...valid,
        enabled,
        autoArchiveSession,
        nextRunAt: isoTime(nextRunAt),
        createdAt: existing?.createdAt ?? new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        lastRun: cancelQueued(existing?.lastRun, now),
      };
      const saved = await this.database.access((connection) =>
        connection.transaction(() => {
          connection
            .prepare(
              `INSERT INTO halo_automations
               (id, extension_id, name, activation, revision, action, enabled, auto_archive_thread, next_run_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               extension_id = excluded.extension_id,
               name = excluded.name,
               activation = excluded.activation,
               revision = excluded.revision,
               action = excluded.action,
               enabled = excluded.enabled,
               auto_archive_thread = excluded.auto_archive_thread,
               next_run_at = excluded.next_run_at,
               updated_at = excluded.updated_at`,
            )
            .run(
              automation.id,
              automation.extensionId ?? null,
              automation.name,
              JSON.stringify(automation.activation),
              automation.revision,
              JSON.stringify(automation.action),
              automation.enabled ? 1 : 0,
              automation.autoArchiveSession ? 1 : 0,
              nullableTime(nextRunAt),
              Date.parse(automation.createdAt),
              now,
            );
          connection
            .prepare(
              "UPDATE halo_automation_runs SET status = 'cancelled', finished_at = ?, error = 'Automation changed before execution.' WHERE automation_id = ? AND status = 'queued'",
            )
            .run(now, automation.id);
        })(),
      );
      if (saved instanceof Error) return saved;
      this.replace(automation);
      return automation;
    });
  }

  async setEnabled(input: { automationId: string; enabled: boolean }) {
    return await this.actionQueue.run(async () => {
      const automation = this.get(input.automationId);
      if (automation instanceof Error) return automation;
      if (automation.enabled === input.enabled) return automation;
      const now = Date.now();
      const nextRunAt = input.enabled
        ? nextActivation({ activation: automation.activation, after: now })
        : undefined;
      if (nextRunAt instanceof Error) return nextRunAt;
      const saved = await this.database.access((connection) =>
        connection.transaction(() => {
          connection
            .prepare(
              "UPDATE halo_automations SET enabled = ?, next_run_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
            )
            .run(
              input.enabled ? 1 : 0,
              nullableTime(nextRunAt),
              now,
              automation.id,
            );
          connection
            .prepare(
              "UPDATE halo_automation_runs SET status = 'cancelled', finished_at = ?, error = 'Automation changed before execution.' WHERE automation_id = ? AND status = 'queued'",
            )
            .run(now, automation.id);
        })(),
      );
      if (saved instanceof Error) return saved;
      const updated: Automation = {
        ...automation,
        enabled: input.enabled,
        revision: automation.revision + 1,
        lastRun: cancelQueued(automation.lastRun, now),
        nextRunAt: isoTime(nextRunAt),
        updatedAt: new Date(now).toISOString(),
      };
      this.replace(updated);
      return updated;
    });
  }

  // Past run sessions stay in the workspace; only the schedule and run index are removed.
  async remove(automationId: string) {
    return await this.actionQueue.run(async () => {
      const automation = this.get(automationId);
      if (automation instanceof Error) return automation;
      const removed = await this.database.access((connection) => {
        connection
          .prepare("DELETE FROM halo_automations WHERE id = ?")
          .run(automationId);
      });
      if (removed instanceof Error) return removed;
      this.publish(this.automations.filter((item) => item.id !== automationId));
    });
  }

  async listRuns(input: { automationId: string; limit?: number }) {
    const automation = this.get(input.automationId);
    if (automation instanceof Error) return automation;
    const rows = await this.database.access((connection) => {
      // SAFETY: The projection matches the halo_automation_runs table.
      return connection
        .prepare(
          `SELECT * FROM halo_automation_runs WHERE automation_id = ?
           ORDER BY started_at DESC, rowid DESC LIMIT ?`,
        )
        .all(input.automationId, input.limit ?? 50) as AutomationRunRow[];
    });
    if (rows instanceof Error) return rows;
    return rows.map(runFromRow);
  }

  async getRun(runId: string) {
    const row = await this.database.access(
      (connection) =>
        // SAFETY: The query selects a complete automation run row.
        connection
          .prepare("SELECT * FROM halo_automation_runs WHERE id = ?")
          .get(runId) as AutomationRunRow | undefined,
    );
    if (row instanceof Error) return row;
    if (row === undefined)
      return new InvalidAutomationError({
        reason: "Automation run does not exist",
      });
    return runFromRow(row);
  }

  async runningSessionIds() {
    const rows = await this.database.access((connection) => {
      // SAFETY: The projection matches the halo_automation_runs table.
      return connection
        .prepare(
          `SELECT thread_id FROM halo_automation_runs
           WHERE status = 'running' AND thread_id IS NOT NULL`,
        )
        .all() as { thread_id: string }[];
    });
    if (rows instanceof Error) return rows;
    return rows.map((row) => row.thread_id);
  }

  // Claim the occurrence and save the action snapshot in the same transaction.
  async beginRun(input: {
    automationId: string;
    trigger: "manual" | "schedule";
    skipReason?: string;
  }) {
    return await this.actionQueue.run(async () => {
      const automation = this.get(input.automationId);
      if (automation instanceof Error) return automation;
      const now = Date.now();
      const scheduledFor =
        input.trigger === "schedule"
          ? scheduledOccurrence({ automation, now })
          : now;
      if (scheduledFor === undefined) return;
      const nextRunAt =
        input.trigger === "schedule"
          ? nextActivation({
              activation: automation.activation,
              after: Math.max(scheduledFor, now),
            })
          : automation.nextRunAt === undefined
            ? undefined
            : Date.parse(automation.nextRunAt);
      if (nextRunAt instanceof Error) return nextRunAt;
      return await this.enqueueUnqueued({
        automation,
        trigger: input.trigger,
        scheduledFor,
        nextRunAt,
        skipReason: input.skipReason,
      });
    });
  }

  async acceptEvent(event: AutomationEvent) {
    if (
      !Value.Check(automationEventSchema, event) ||
      !Number.isFinite(Date.parse(event.occurredAt))
    )
      return new InvalidAutomationError({ reason: "Invalid automation event" });
    const payload = errore.try({
      try: () => JSON.stringify(event),
      catch: (cause) =>
        new InvalidAutomationError({
          reason: "Event must contain JSON data",
          cause,
        }),
    });
    if (payload instanceof Error) return payload;
    if (Buffer.byteLength(payload) > 270_000)
      return new InvalidAutomationError({
        reason: "Event exceeds the payload limit",
      });
    return await this.actionQueue.run(async () => {
      const existing = await this.database.access(
        (connection) =>
          // SAFETY: The query selects a complete automation run row.
          connection
            .prepare("SELECT * FROM halo_automation_runs WHERE event_id = ?")
            .get(event.eventId) as AutomationRunRow | undefined,
      );
      if (existing instanceof Error) return existing;
      if (existing !== undefined) {
        if (
          existing.automation_id !== event.automationId ||
          existing.revision !== event.revision ||
          existing.payload !== payload
        )
          return new InvalidAutomationError({
            reason: "Event ID already belongs to a different delivery",
          });
        return runFromRow(existing);
      }
      const automation = this.get(event.automationId);
      if (automation instanceof Error) return automation;
      if (
        !automation.enabled ||
        automation.revision !== event.revision ||
        automation.activation.type !== "trigger" ||
        automation.activation.trigger.type !== event.source
      )
        return new InvalidAutomationError({
          reason: "The automation is paused or its activation has changed",
        });
      return await this.enqueueUnqueued({
        automation,
        trigger: "event",
        scheduledFor: Date.parse(event.occurredAt),
        event,
        payload,
      });
    });
  }

  private async enqueueUnqueued(input: {
    automation: Automation;
    trigger: AutomationRunTrigger;
    scheduledFor: number;
    nextRunAt?: number;
    skipReason?: string;
    event?: AutomationEvent;
    payload?: string;
  }) {
    const { automation } = input;
    const now = Date.now();
    const run: AutomationRun = {
      id: randomUUID(),
      automationId: automation.id,
      revision: automation.revision,
      trigger: input.trigger,
      eventId: input.event?.eventId,
      scheduledFor: new Date(input.scheduledFor).toISOString(),
      status: input.skipReason === undefined ? "queued" : "skipped",
      startedAt: new Date(now).toISOString(),
      finishedAt:
        input.skipReason === undefined
          ? undefined
          : new Date(now).toISOString(),
      error: input.skipReason,
    };
    const saved = await this.database.access((connection) =>
      connection.transaction(() => {
        // SAFETY: COUNT produces one numeric count row.
        const pending = connection
          .prepare(
            "SELECT count(*) AS count FROM halo_automation_runs WHERE status = 'queued'",
          )
          .get() as { count: number };
        if (pending.count >= 1000)
          return new InvalidAutomationError({
            reason: "Automation queue is full; retry later",
          });
        connection
          .prepare(`INSERT INTO halo_automation_runs
        (id, automation_id, revision, trigger, event_id, scheduled_for, status, started_at, finished_at, error, snapshot, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            run.id,
            run.automationId,
            run.revision,
            run.trigger,
            run.eventId ?? null,
            input.scheduledFor,
            run.status,
            now,
            input.skipReason === undefined ? null : now,
            input.skipReason ?? null,
            JSON.stringify({ ...automation, lastRun: undefined }),
            input.payload ?? null,
          );
        if (input.trigger === "schedule")
          connection
            .prepare("UPDATE halo_automations SET next_run_at = ? WHERE id = ?")
            .run(nullableTime(input.nextRunAt), automation.id);
      })(),
    );
    if (saved instanceof Error) return saved;
    this.replace({
      ...automation,
      nextRunAt:
        input.trigger === "schedule"
          ? isoTime(input.nextRunAt)
          : automation.nextRunAt,
      lastRun: run.status === "skipped" ? automation.lastRun : run,
    });
    return run;
  }

  // Called by the single workspace runner. The database claim prevents overlapping actions.
  async claimNext() {
    return await this.actionQueue.run(async () => {
      const claimed = await this.database.access((connection) =>
        connection.transaction(() => {
          // SAFETY: The query selects complete run rows; the state predicate excludes active automations.
          const row = connection
            .prepare(`SELECT * FROM halo_automation_runs AS candidate
          WHERE status = 'queued' AND NOT EXISTS (
            SELECT 1 FROM halo_automation_runs AS active WHERE active.automation_id = candidate.automation_id AND active.status = 'running'
          ) ORDER BY started_at, rowid LIMIT 1`)
            .get() as AutomationRunRow | undefined;
          if (row === undefined) return;
          const automation = this.get(row.automation_id);
          if (automation instanceof Error) return automation;
          if (automation.revision !== row.revision)
            return new InvalidAutomationError({
              reason: "Queued automation revision no longer exists",
            });
          // All newly queued runs carry a validated snapshot saved by enqueueUnqueued.
          const snapshot = errore.try({
            // SAFETY: The snapshot is written only from a validated Automation in enqueueUnqueued.
            try: () => JSON.parse(row.snapshot!) as Automation,
            catch: (cause) =>
              new InvalidAutomationError({
                reason: "Could not read queued action",
                cause,
              }),
          });
          if (snapshot instanceof Error) return snapshot;
          const event =
            row.payload === null
              ? undefined
              : errore.try({
                  // SAFETY: Payload was validated against automationEventSchema before enqueueing.
                  try: () => JSON.parse(row.payload!) as AutomationEvent,
                  catch: (cause) =>
                    new InvalidAutomationError({
                      reason: "Could not read queued event",
                      cause,
                    }),
                });
          if (event instanceof Error) return event;
          connection
            .prepare(
              "UPDATE halo_automation_runs SET status = 'running' WHERE id = ? AND status = 'queued'",
            )
            .run(row.id);
          return {
            automation: snapshot,
            run: { ...runFromRow(row), status: "running" as const },
            event,
          };
        })(),
      );
      if (claimed instanceof Error || claimed === undefined) return claimed;
      const automation = this.get(claimed.automation.id);
      if (automation instanceof Error) return automation;
      if (automation.lastRun?.id === claimed.run.id)
        this.replace({ ...automation, lastRun: claimed.run });
      return claimed;
    });
  }

  async attachSession(input: { runId: string; sessionId: string }) {
    return await this.updateRun({
      runId: input.runId,
      sql: "UPDATE halo_automation_runs SET thread_id = ? WHERE id = ?",
      params: [input.sessionId, input.runId],
      apply: (run) => ({ ...run, sessionId: input.sessionId }),
    });
  }

  // Only a running run can finish, so a late outcome cannot replace an interruption.
  async finishRun(input: {
    runId: string;
    status: Exclude<AutomationRunStatus, "running" | "skipped">;
    error?: string;
  }) {
    const now = Date.now();
    return await this.updateRun({
      runId: input.runId,
      sql: `UPDATE halo_automation_runs SET status = ?, finished_at = ?, error = ?
            WHERE id = ? AND status = 'running'`,
      params: [input.status, now, input.error ?? null, input.runId],
      apply: (run) =>
        run.status === "running"
          ? {
              ...run,
              status: input.status,
              finishedAt: new Date(now).toISOString(),
              error: input.error,
            }
          : run,
    });
  }

  // Marks runs left by a stopped process as interrupted. Local scheduling skips missed
  // occurrences; managed scheduling preserves the due time for the control plane to dispatch.
  async recover(options?: { preserveDue?: boolean }) {
    return await this.actionQueue.run(async () => {
      const now = Date.now();
      const nextRuns = new Map<string, number | undefined>();
      for (const automation of this.automations) {
        if (!automation.enabled) continue;
        const nextRunAt =
          options?.preserveDue && automation.nextRunAt !== undefined
            ? Date.parse(automation.nextRunAt)
            : nextActivation({ activation: automation.activation, after: now });
        // A stored schedule that no longer resolves stays paused until edited.
        nextRuns.set(
          automation.id,
          nextRunAt instanceof Error ? undefined : nextRunAt,
        );
      }
      const saved = await this.database.access((connection) =>
        connection.transaction(() => {
          connection
            .prepare(
              `UPDATE halo_automation_runs SET status = 'interrupted', finished_at = ?,
                 error = 'Halo stopped before the run finished.'
               WHERE status = 'running'`,
            )
            .run(now);
          const update = connection.prepare(
            "UPDATE halo_automations SET next_run_at = ? WHERE id = ?",
          );
          for (const [automationId, nextRunAt] of nextRuns)
            update.run(nullableTime(nextRunAt), automationId);
        })(),
      );
      if (saved instanceof Error) return saved;
      this.publish(
        this.automations.map((automation) => ({
          ...automation,
          nextRunAt: nextRuns.has(automation.id)
            ? isoTime(nextRuns.get(automation.id))
            : automation.nextRunAt,
          lastRun:
            automation.lastRun?.status === "running"
              ? {
                  ...automation.lastRun,
                  status: "interrupted",
                  finishedAt: new Date(now).toISOString(),
                  error: "Halo stopped before the run finished.",
                }
              : automation.lastRun,
        })),
      );
    });
  }

  private async updateRun(input: {
    runId: string;
    sql: string;
    params: (string | number | null)[];
    apply: (run: AutomationRun) => AutomationRun;
  }) {
    return await this.actionQueue.run(async () => {
      const saved = await this.database.access((connection) => {
        connection.prepare(input.sql).run(...input.params);
      });
      if (saved instanceof Error) return saved;
      const automation = this.automations.find(
        (item) => item.lastRun?.id === input.runId,
      );
      if (automation?.lastRun === undefined) return;
      this.replace({ ...automation, lastRun: input.apply(automation.lastRun) });
    });
  }

  private replace(automation: Automation) {
    const index = this.automations.findIndex(
      (item) => item.id === automation.id,
    );
    this.publish(
      index === -1
        ? [...this.automations, automation]
        : this.automations.with(index, automation),
    );
  }

  private publish(automations: Automation[]) {
    this.automations = automations;
    this.changes.append(automations);
  }
}

// Returns the first occurrence strictly after `after`, in epoch milliseconds.
function nextOccurrence(input: {
  cron: string;
  timezone: string;
  after: number;
}) {
  const next = errore.try({
    try: () =>
      new Cron(input.cron, {
        timezone: input.timezone,
        paused: true,
      }).nextRun(new Date(input.after)),
    catch: (cause) =>
      new InvalidAutomationError({
        reason: `Invalid schedule: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
  if (next instanceof Error) return next;
  if (next === null)
    return new InvalidAutomationError({
      reason: `The schedule '${input.cron}' never runs.`,
    });
  return next.getTime();
}

function validateInput(input: AutomationInput) {
  if (!Value.Check(automationInputSchema, input))
    return new InvalidAutomationError({ reason: "Invalid automation input" });
  if (
    input.extensionId !== undefined &&
    !extensionIdPattern.test(input.extensionId)
  )
    return new InvalidAutomationError({
      reason:
        "Use an extension ID with lowercase letters, digits, and hyphens, such as appointments.",
    });
  const name = input.name.trim();
  if (name === "")
    return new InvalidAutomationError({ reason: "A automation needs a name" });
  const activation = validateActivation(input.activation);
  if (activation instanceof Error) return activation;
  const action = validateAction(input.action);
  if (action instanceof Error) return action;
  return { extensionId: input.extensionId, name, activation, action };
}

function validateAction(action: AutomationAction) {
  if (action.type === "runAgent") {
    const prompt = action.prompt.trim();
    if (prompt === "")
      return new InvalidAutomationError({
        reason: "An agent automation needs a prompt",
      });
    return { type: action.type, prompt };
  }
  const command = action.command.trim();
  if (command === "")
    return new InvalidAutomationError({
      reason: "A script automation needs a command",
    });
  if (action.cwd === undefined) return { type: action.type, command };
  if (
    action.cwd.startsWith("/") ||
    action.cwd.includes("\\") ||
    action.cwd.split("/").some((part) => part === ".." || part === "")
  )
    return new InvalidAutomationError({
      reason:
        "Use a workspace-relative working directory without parent directory segments",
    });
  return { type: action.type, command, cwd: action.cwd };
}

function isTimeZone(timezone: string) {
  const format = errore.try({
    try: () => new Intl.DateTimeFormat("en-US", { timeZone: timezone }),
    catch: (cause) => new InvalidAutomationError({ reason: timezone, cause }),
  });
  return !(format instanceof Error);
}

// The due occurrence a timer is firing for, if the automation is still enabled and due.
function scheduledOccurrence(input: { automation: Automation; now: number }) {
  if (!input.automation.enabled || input.automation.nextRunAt === undefined)
    return;
  const nextRunAt = Date.parse(input.automation.nextRunAt);
  if (nextRunAt > input.now) return;
  return nextRunAt;
}

function automationFromRow(
  row: AutomationRow,
  lastRun: AutomationRun | undefined,
) {
  const action = errore.try({
    // SAFETY: Parsed JSON stays unknown until the schema check below.
    try: () => JSON.parse(row.action) as unknown,
    catch: (cause) =>
      new InvalidAutomationError({
        reason: `Could not read automation '${row.id}'`,
        cause,
      }),
  });
  if (action instanceof Error) return action;
  if (!Value.Check(automationActionSchema, action))
    return new InvalidAutomationError({
      reason: `Automation '${row.id}' has an invalid action`,
    });
  const activation = errore.try({
    // SAFETY: Parsed JSON stays unknown until the activation schema check below.
    try: () => JSON.parse(row.activation) as unknown,
    catch: (cause) =>
      new InvalidAutomationError({
        reason: `Could not read automation '${row.id}'`,
        cause,
      }),
  });
  if (activation instanceof Error) return activation;
  if (!Value.Check(automationActivationSchema, activation))
    return new InvalidAutomationError({
      reason: `Automation '${row.id}' has an invalid activation`,
    });
  const automation: Automation = {
    id: row.id,
    extensionId: row.extension_id ?? undefined,
    name: row.name,
    activation,
    revision: row.revision,
    action,
    enabled: row.enabled === 1,
    autoArchiveSession: row.auto_archive_thread === 1,
    nextRunAt:
      row.next_run_at === null
        ? undefined
        : new Date(row.next_run_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastRun,
  };
  return automation;
}

function runFromRow(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    revision: row.revision,
    eventId: row.event_id ?? undefined,
    trigger: row.trigger,
    scheduledFor: new Date(row.scheduled_for).toISOString(),
    sessionId: row.thread_id === null ? undefined : row.thread_id,
    status: row.status,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt:
      row.finished_at === null
        ? undefined
        : new Date(row.finished_at).toISOString(),
    error: row.error === null ? undefined : row.error,
  };
}

function isoTime(time: number | undefined) {
  return time === undefined ? undefined : new Date(time).toISOString();
}

function nullableTime(time: number | undefined) {
  return time ?? null;
}

function nextActivation(input: {
  activation: AutomationActivation;
  after: number;
}) {
  if (input.activation.type === "trigger") return;
  return nextOccurrence({ ...input.activation.schedule, after: input.after });
}

function validateActivation(activation: AutomationActivation) {
  if (activation.type === "trigger") {
    if (activation.trigger.type === "webhook") return activation;
    const trigger = activation.trigger;
    const connectionAddress = trigger.connectionAddress.trim();
    if (connectionAddress === "")
      return new InvalidAutomationError({
        reason: "Choose a Gmail connection",
      });
    const from = trigger.from?.trim().toLowerCase();
    if (from !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from))
      return new InvalidAutomationError({
        reason: "Use a complete sender email address",
      });
    const subjectContains = trigger.subjectContains?.trim();
    if (subjectContains === "")
      return new InvalidAutomationError({
        reason: "The subject filter cannot be empty",
      });
    return {
      ...activation,
      trigger: { ...trigger, connectionAddress, from, subjectContains },
    };
  }
  const cron = activation.schedule.cron.trim().split(/\s+/).join(" ");
  if (cron.split(" ").length !== 5)
    return new InvalidAutomationError({
      reason:
        "Use a five-field cron expression: minute hour day-of-month month day-of-week (for example '0 8 * * 1-5').",
    });
  const timezone = activation.schedule.timezone.trim();
  if (!isTimeZone(timezone))
    return new InvalidAutomationError({
      reason: `Unknown time zone '${timezone}'. Use an IANA name such as America/New_York or UTC.`,
    });
  const next = nextOccurrence({ cron, timezone, after: Date.now() });
  if (next instanceof Error) return next;
  return { ...activation, schedule: { cron, timezone } };
}

function cancelQueued(
  run: AutomationRun | undefined,
  now: number,
): AutomationRun | undefined {
  if (run?.status !== "queued") return run;
  return {
    ...run,
    status: "cancelled",
    finishedAt: new Date(now).toISOString(),
    error: "Automation changed before execution.",
  };
}
