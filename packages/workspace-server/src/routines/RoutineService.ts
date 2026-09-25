// oxlint-disable unicorn/no-null -- SQL rows and bindings use null for NULL.
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { Cron } from "croner";
import * as errore from "errore";
import {
  routineActionSchema,
  routineInputSchema,
  InvalidRoutineError,
  type Routine,
  type RoutineAction,
  type RoutineInput,
  type RoutineRun,
  type RoutineRunStatus,
  type RoutineRunTrigger,
} from "@get-halo/client";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import { Stream } from "@get-halo/shared/Stream";
import type { DatabaseClient } from "../storage/DatabaseClient.js";

export class RoutineNotFoundError extends errore.createTaggedError({
  name: "RoutineNotFoundError",
  message: "Routine '$routineId' does not exist. List routines to find its ID.",
}) {}

type RoutineRow = {
  id: string;
  extension_id: string;
  name: string;
  cron: string;
  timezone: string;
  action: string;
  enabled: number;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
};

type RoutineRunRow = {
  id: string;
  routine_id: string;
  trigger: RoutineRunTrigger;
  scheduled_for: number;
  session_id: string | null;
  status: RoutineRunStatus;
  started_at: number;
  finished_at: number | null;
  error: string | null;
};

const extensionIdPattern = /^[a-z][a-z0-9-]*$/;

export class RoutineService {
  // Committed routines with their latest run; one queue orders writes and initial subscriptions.
  private routines: Routine[];
  private readonly changes = new Stream<Routine[]>();
  private readonly actionQueue = new SerialQueue();
  private readonly database: DatabaseClient;

  private constructor(ctx: { database: DatabaseClient; routines: Routine[] }) {
    this.database = ctx.database;
    this.routines = ctx.routines;
  }

  static async open(ctx: { database: DatabaseClient }) {
    const stored = await ctx.database.access((connection) => {
      // SAFETY: The projection matches the halo_routines table.
      const routines = connection
        .prepare("SELECT * FROM halo_routines ORDER BY created_at, id")
        .all() as RoutineRow[];
      // SAFETY: The projection matches the halo_routine_runs table.
      const lastRuns = connection
        .prepare(
          `SELECT * FROM halo_routine_runs AS run
           WHERE run.id = (
             SELECT latest.id FROM halo_routine_runs AS latest
             WHERE latest.routine_id = run.routine_id AND latest.status != 'skipped'
             ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1
           )`,
        )
        .all() as RoutineRunRow[];
      return { routines, lastRuns };
    });
    if (stored instanceof Error) return stored;
    const lastRuns = new Map(
      stored.lastRuns.map((row) => [row.routine_id, runFromRow(row)]),
    );
    const routines: Routine[] = [];
    for (const row of stored.routines) {
      const routine = routineFromRow(row, lastRuns.get(row.id));
      if (routine instanceof Error) return routine;
      routines.push(routine);
    }
    return new RoutineService({ database: ctx.database, routines });
  }

  list() {
    return this.routines;
  }

  get(routineId: string) {
    return (
      this.routines.find((routine) => routine.id === routineId) ??
      new RoutineNotFoundError({ routineId })
    );
  }

  subscribe(listener: (routines: Routine[]) => void) {
    return this.changes.subscribe(listener);
  }

  async *watch(signal: AbortSignal | undefined) {
    const initial = await this.actionQueue.run(() => ({
      routines: this.routines,
      updates: this.changes.consume({ abortSignal: signal }),
    }));
    using updates = initial.updates;
    if (signal?.aborted) return;
    yield initial.routines;
    yield* updates;
  }

  async save(input: RoutineInput) {
    const valid = validateInput(input);
    if (valid instanceof Error) return valid;
    return await this.actionQueue.run(async () => {
      const existing = this.routines.find((routine) => routine.id === input.id);
      if (input.id !== undefined && existing === undefined)
        return new RoutineNotFoundError({ routineId: input.id });
      const now = Date.now();
      const enabled = input.enabled ?? existing?.enabled ?? true;
      const nextRunAt = enabled
        ? nextOccurrence({ ...valid, after: now })
        : undefined;
      if (nextRunAt instanceof Error) return nextRunAt;
      const routine: Routine = {
        id: existing?.id ?? randomUUID(),
        ...valid,
        enabled,
        nextRunAt: isoTime(nextRunAt),
        createdAt: existing?.createdAt ?? new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        lastRun: existing?.lastRun,
      };
      const saved = await this.database.access((connection) => {
        connection
          .prepare(
            `INSERT INTO halo_routines
               (id, extension_id, name, cron, timezone, action, enabled, next_run_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               extension_id = excluded.extension_id,
               name = excluded.name,
               cron = excluded.cron,
               timezone = excluded.timezone,
               action = excluded.action,
               enabled = excluded.enabled,
               next_run_at = excluded.next_run_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            routine.id,
            routine.extensionId,
            routine.name,
            routine.cron,
            routine.timezone,
            JSON.stringify(routine.action),
            routine.enabled ? 1 : 0,
            nullableTime(nextRunAt),
            Date.parse(routine.createdAt),
            now,
          );
      });
      if (saved instanceof Error) return saved;
      this.replace(routine);
      return routine;
    });
  }

  async setEnabled(input: { routineId: string; enabled: boolean }) {
    return await this.actionQueue.run(async () => {
      const routine = this.get(input.routineId);
      if (routine instanceof Error) return routine;
      if (routine.enabled === input.enabled) return routine;
      const now = Date.now();
      const nextRunAt = input.enabled
        ? nextOccurrence({ ...routine, after: now })
        : undefined;
      if (nextRunAt instanceof Error) return nextRunAt;
      const saved = await this.database.access((connection) => {
        connection
          .prepare(
            "UPDATE halo_routines SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(input.enabled ? 1 : 0, nullableTime(nextRunAt), now, routine.id);
      });
      if (saved instanceof Error) return saved;
      const updated: Routine = {
        ...routine,
        enabled: input.enabled,
        nextRunAt: isoTime(nextRunAt),
        updatedAt: new Date(now).toISOString(),
      };
      this.replace(updated);
      return updated;
    });
  }

  // Past run sessions stay in the workspace; only the schedule and run index are removed.
  async remove(routineId: string) {
    return await this.actionQueue.run(async () => {
      const routine = this.get(routineId);
      if (routine instanceof Error) return routine;
      const removed = await this.database.access((connection) => {
        connection
          .prepare("DELETE FROM halo_routines WHERE id = ?")
          .run(routineId);
      });
      if (removed instanceof Error) return removed;
      this.publish(this.routines.filter((item) => item.id !== routineId));
    });
  }

  async listRuns(input: { routineId: string; limit?: number }) {
    const routine = this.get(input.routineId);
    if (routine instanceof Error) return routine;
    const rows = await this.database.access((connection) => {
      // SAFETY: The projection matches the halo_routine_runs table.
      return connection
        .prepare(
          `SELECT * FROM halo_routine_runs WHERE routine_id = ?
           ORDER BY started_at DESC, rowid DESC LIMIT ?`,
        )
        .all(input.routineId, input.limit ?? 50) as RoutineRunRow[];
    });
    if (rows instanceof Error) return rows;
    return rows.map(runFromRow);
  }

  // Starts one run record. A scheduled run claims the due occurrence and advances the schedule
  // in the same step; it returns undefined when nothing is due, such as after a pause.
  async beginRun(input: {
    routineId: string;
    trigger: RoutineRunTrigger;
    // Records the run as skipped with this reason instead of starting it.
    skipReason?: string;
  }) {
    return await this.actionQueue.run(async () => {
      const routine = this.get(input.routineId);
      if (routine instanceof Error) return routine;
      const now = Date.now();
      const scheduledFor =
        input.trigger === "schedule"
          ? scheduledOccurrence({ routine, now })
          : now;
      if (scheduledFor === undefined) return;
      const nextRunAt =
        input.trigger === "schedule"
          ? nextOccurrence({ ...routine, after: Math.max(scheduledFor, now) })
          : routine.nextRunAt === undefined
            ? undefined
            : Date.parse(routine.nextRunAt);
      if (nextRunAt instanceof Error) return nextRunAt;
      const skipReason =
        input.skipReason ??
        (routine.lastRun?.status === "running"
          ? "The previous run is still running."
          : undefined);
      const run: RoutineRun = {
        id: randomUUID(),
        routineId: routine.id,
        trigger: input.trigger,
        scheduledFor: new Date(scheduledFor).toISOString(),
        status: skipReason === undefined ? "running" : "skipped",
        startedAt: new Date(now).toISOString(),
        finishedAt:
          skipReason === undefined ? undefined : new Date(now).toISOString(),
        error: skipReason,
      };
      const saved = await this.database.access((connection) =>
        connection.transaction(() => {
          connection
            .prepare(
              `INSERT INTO halo_routine_runs
                 (id, routine_id, trigger, scheduled_for, status, started_at, finished_at, error)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              run.id,
              run.routineId,
              run.trigger,
              scheduledFor,
              run.status,
              now,
              skipReason === undefined ? null : now,
              skipReason ?? null,
            );
          connection
            .prepare("UPDATE halo_routines SET next_run_at = ? WHERE id = ?")
            .run(nullableTime(nextRunAt), routine.id);
        })(),
      );
      if (saved instanceof Error) return saved;
      this.replace({
        ...routine,
        nextRunAt: isoTime(nextRunAt),
        lastRun: skipReason === undefined ? run : routine.lastRun,
      });
      return run;
    });
  }

  async attachSession(input: { runId: string; sessionId: string }) {
    return await this.updateRun({
      runId: input.runId,
      sql: "UPDATE halo_routine_runs SET session_id = ? WHERE id = ?",
      params: [input.sessionId, input.runId],
      apply: (run) => ({ ...run, sessionId: input.sessionId }),
    });
  }

  // Only a running run can finish, so a late outcome cannot replace an interruption.
  async finishRun(input: {
    runId: string;
    status: Exclude<RoutineRunStatus, "running" | "skipped">;
    error?: string;
  }) {
    const now = Date.now();
    return await this.updateRun({
      runId: input.runId,
      sql: `UPDATE halo_routine_runs SET status = ?, finished_at = ?, error = ?
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

  // Marks runs left by a stopped process as interrupted and skips occurrences missed while
  // it was stopped by scheduling each enabled routine from now.
  async recover() {
    return await this.actionQueue.run(async () => {
      const now = Date.now();
      const nextRuns = new Map<string, number | undefined>();
      for (const routine of this.routines) {
        if (!routine.enabled) continue;
        const nextRunAt = nextOccurrence({ ...routine, after: now });
        // A stored schedule that no longer resolves stays paused until edited.
        nextRuns.set(
          routine.id,
          nextRunAt instanceof Error ? undefined : nextRunAt,
        );
      }
      const saved = await this.database.access((connection) =>
        connection.transaction(() => {
          connection
            .prepare(
              `UPDATE halo_routine_runs SET status = 'interrupted', finished_at = ?,
                 error = 'Halo stopped before the run finished.'
               WHERE status = 'running'`,
            )
            .run(now);
          const update = connection.prepare(
            "UPDATE halo_routines SET next_run_at = ? WHERE id = ?",
          );
          for (const [routineId, nextRunAt] of nextRuns)
            update.run(nullableTime(nextRunAt), routineId);
        })(),
      );
      if (saved instanceof Error) return saved;
      this.publish(
        this.routines.map((routine) => ({
          ...routine,
          nextRunAt: nextRuns.has(routine.id)
            ? isoTime(nextRuns.get(routine.id))
            : routine.nextRunAt,
          lastRun:
            routine.lastRun?.status === "running"
              ? {
                  ...routine.lastRun,
                  status: "interrupted",
                  finishedAt: new Date(now).toISOString(),
                  error: "Halo stopped before the run finished.",
                }
              : routine.lastRun,
        })),
      );
    });
  }

  private async updateRun(input: {
    runId: string;
    sql: string;
    params: (string | number | null)[];
    apply: (run: RoutineRun) => RoutineRun;
  }) {
    return await this.actionQueue.run(async () => {
      const saved = await this.database.access((connection) => {
        connection.prepare(input.sql).run(...input.params);
      });
      if (saved instanceof Error) return saved;
      const routine = this.routines.find(
        (item) => item.lastRun?.id === input.runId,
      );
      if (routine?.lastRun === undefined) return;
      this.replace({ ...routine, lastRun: input.apply(routine.lastRun) });
    });
  }

  private replace(routine: Routine) {
    const index = this.routines.findIndex((item) => item.id === routine.id);
    this.publish(
      index === -1
        ? [...this.routines, routine]
        : this.routines.with(index, routine),
    );
  }

  private publish(routines: Routine[]) {
    this.routines = routines;
    this.changes.append(routines);
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
      new InvalidRoutineError({
        reason: `Invalid schedule: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
  if (next instanceof Error) return next;
  if (next === null)
    return new InvalidRoutineError({
      reason: `The schedule '${input.cron}' never runs.`,
    });
  return next.getTime();
}

function validateInput(input: RoutineInput) {
  if (!Value.Check(routineInputSchema, input))
    return new InvalidRoutineError({ reason: "Invalid routine input" });
  if (!extensionIdPattern.test(input.extensionId))
    return new InvalidRoutineError({
      reason:
        "Use an extension ID with lowercase letters, digits, and hyphens, such as appointments.",
    });
  const name = input.name.trim();
  if (name === "")
    return new InvalidRoutineError({ reason: "A routine needs a name" });
  const cron = input.cron.trim().split(/\s+/).join(" ");
  if (cron.split(" ").length !== 5)
    return new InvalidRoutineError({
      reason:
        "Use a five-field cron expression: minute hour day-of-month month day-of-week (for example '0 8 * * 1-5').",
    });
  const timezone = input.timezone.trim();
  if (!isTimeZone(timezone))
    return new InvalidRoutineError({
      reason: `Unknown time zone '${timezone}'. Use an IANA name such as America/New_York or UTC.`,
    });
  const next = nextOccurrence({ cron, timezone, after: Date.now() });
  if (next instanceof Error) return next;
  const action = validateAction(input.action);
  if (action instanceof Error) return action;
  return { extensionId: input.extensionId, name, cron, timezone, action };
}

function validateAction(action: RoutineAction) {
  if (action.type === "runAgent") {
    const prompt = action.prompt.trim();
    if (prompt === "")
      return new InvalidRoutineError({
        reason: "An agent routine needs a prompt",
      });
    return { type: action.type, prompt };
  }
  const command = action.command.trim();
  if (command === "")
    return new InvalidRoutineError({
      reason: "A script routine needs a command",
    });
  if (action.cwd === undefined) return { type: action.type, command };
  if (
    action.cwd.startsWith("/") ||
    action.cwd.includes("\\") ||
    action.cwd.split("/").some((part) => part === ".." || part === "")
  )
    return new InvalidRoutineError({
      reason:
        "Use a workspace-relative working directory without parent directory segments",
    });
  return { type: action.type, command, cwd: action.cwd };
}

function isTimeZone(timezone: string) {
  const format = errore.try({
    try: () => new Intl.DateTimeFormat("en-US", { timeZone: timezone }),
    catch: (cause) => new InvalidRoutineError({ reason: timezone, cause }),
  });
  return !(format instanceof Error);
}

// The due occurrence a timer is firing for, if the routine is still enabled and due.
function scheduledOccurrence(input: { routine: Routine; now: number }) {
  if (!input.routine.enabled || input.routine.nextRunAt === undefined) return;
  const nextRunAt = Date.parse(input.routine.nextRunAt);
  if (nextRunAt > input.now) return;
  return nextRunAt;
}

function routineFromRow(row: RoutineRow, lastRun: RoutineRun | undefined) {
  const action = errore.try({
    // SAFETY: Parsed JSON stays unknown until the schema check below.
    try: () => JSON.parse(row.action) as unknown,
    catch: (cause) =>
      new InvalidRoutineError({
        reason: `Could not read routine '${row.id}'`,
        cause,
      }),
  });
  if (action instanceof Error) return action;
  if (!Value.Check(routineActionSchema, action))
    return new InvalidRoutineError({
      reason: `Routine '${row.id}' has an invalid action`,
    });
  const routine: Routine = {
    id: row.id,
    extensionId: row.extension_id,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    action,
    enabled: row.enabled === 1,
    nextRunAt:
      row.next_run_at === null
        ? undefined
        : new Date(row.next_run_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastRun,
  };
  return routine;
}

function runFromRow(row: RoutineRunRow): RoutineRun {
  return {
    id: row.id,
    routineId: row.routine_id,
    trigger: row.trigger,
    scheduledFor: new Date(row.scheduled_for).toISOString(),
    sessionId: row.session_id === null ? undefined : row.session_id,
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
