// oxlint-disable unicorn/no-null -- Cron and Tandem relations use null for absence.
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { Cron } from "croner";
import * as errore from "errore";
import {
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
import type {
  DatabaseService,
  WorkspaceSchema,
} from "../database/DatabaseService.js";

export class RoutineNotFoundError extends errore.createTaggedError({
  name: "RoutineNotFoundError",
  message: "Routine '$routineId' does not exist. List routines to find its ID.",
}) {}

class RoutineStorageError extends errore.createTaggedError({
  name: "RoutineStorageError",
  message: "Routine storage failed during $operation",
}) {}

type RoutineTransaction = ReturnType<DatabaseService["tandem"]["transact"]>;
type RoutineWithRun = WorkspaceSchema["routines"] & {
  lastRun: WorkspaceSchema["routineRuns"] | null;
};
const routineQuery = {
  collection: "routines",
  orderBy: { createdAt: "asc", id: "asc" },
  with: { lastRun: true },
} as const;
const extensionIdPattern = /^[a-z][a-z0-9-]*$/;

export class RoutineService {
  // Orders commands; records and related run snapshots belong to Tandem.
  private readonly actionQueue = new SerialQueue();
  private readonly tandem: DatabaseService["tandem"];

  constructor(ctx: { tandem: DatabaseService["tandem"] }) {
    this.tandem = ctx.tandem;
  }

  async list() {
    const records = await this.tandem
      .query(routineQuery)
      .catch((cause) => new RoutineStorageError({ operation: "list", cause }));
    if (records instanceof Error) return records;
    return records.map(toRoutine);
  }

  async get(routineId: string) {
    return await readRoutine(this.tandem, routineId);
  }

  async subscribe(
    listener: (routines: Routine[]) => void,
    onError: (error: Error) => void,
  ) {
    const subscription = await this.tandem
      .subscribe(routineQuery, (records) => listener(records.map(toRoutine)), {
        onError,
      })
      .catch(
        (cause) => new RoutineStorageError({ operation: "subscribe", cause }),
      );
    if (subscription instanceof Error) return subscription;
    return {
      result: subscription.result.map(toRoutine),
      destroy: subscription.destroy,
    };
  }

  async *watch(signal: AbortSignal | undefined) {
    const changes = new Stream<Routine[] | Error>();
    using updates = changes.consume({ abortSignal: signal });
    using cleanup = new errore.DisposableStack();
    if (signal?.aborted) return;
    const subscription = await this.subscribe(
      (routines) => changes.append(routines),
      (error) => changes.append(error),
    );
    if (subscription instanceof Error) {
      yield subscription;
      return;
    }
    cleanup.defer(() => subscription.destroy());
    if (signal?.aborted) return;
    yield subscription.result;
    yield* updates;
  }

  async save(input: RoutineInput) {
    const valid = validateInput(input);
    if (valid instanceof Error) return valid;
    return await this.change(async (transaction) => {
      const existing =
        input.id === undefined
          ? undefined
          : await readRecord(transaction, input.id);
      if (existing instanceof Error) return existing;
      const now = Date.now();
      const enabled = input.enabled ?? existing?.enabled ?? true;
      const nextRunAt = enabled
        ? nextOccurrence({ ...valid, after: now })
        : undefined;
      if (nextRunAt instanceof Error) return nextRunAt;
      const routine: WorkspaceSchema["routines"] = {
        id: existing?.id ?? randomUUID(),
        ...valid,
        enabled,
        autoArchiveSession:
          input.autoArchiveSession ?? existing?.autoArchiveSession ?? false,
        nextRunAt: isoTime(nextRunAt),
        createdAt: existing?.createdAt ?? new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        lastRunId: existing?.lastRunId,
        runSequence: existing?.runSequence ?? 0,
      };
      transaction.set("routines", routine);
      return await readRoutine(transaction, routine.id);
    });
  }

  async setEnabled(input: { routineId: string; enabled: boolean }) {
    return await this.change(async (transaction) => {
      const routine = await readRecord(transaction, input.routineId);
      if (routine instanceof Error) return routine;
      if (routine.enabled === input.enabled)
        return await readRoutine(transaction, routine.id);
      const now = Date.now();
      const nextRunAt = input.enabled
        ? nextOccurrence({ ...routine, after: now })
        : undefined;
      if (nextRunAt instanceof Error) return nextRunAt;
      transaction.set("routines", {
        ...routine,
        enabled: input.enabled,
        nextRunAt: isoTime(nextRunAt),
        updatedAt: new Date(now).toISOString(),
      });
      return await readRoutine(transaction, routine.id);
    });
  }

  // Explicitly delete run records so Tandem invalidates both collections. Sessions stay.
  async remove(routineId: string) {
    return await this.change(async (transaction) => {
      const routine = await readRecord(transaction, routineId);
      if (routine instanceof Error) return routine;
      const runs = await transaction
        .query({ collection: "routineRuns", where: { routineId } })
        .catch(
          (cause) =>
            new RoutineStorageError({
              operation: "read runs before remove",
              cause,
            }),
        );
      if (runs instanceof Error) return runs;
      for (const run of runs) transaction.remove("routineRuns", run.id);
      transaction.remove("routines", routineId);
    });
  }

  async listRuns(input: { routineId: string; limit?: number }) {
    const routine = await this.get(input.routineId);
    if (routine instanceof Error) return routine;
    const runs = await this.tandem
      .query({
        collection: "routineRuns",
        where: { routineId: input.routineId },
        orderBy: { startedAt: "desc", sequence: "desc" },
        limit: input.limit ?? 50,
      })
      .catch(
        (cause) => new RoutineStorageError({ operation: "list runs", cause }),
      );
    if (runs instanceof Error) return runs;
    return runs.map(toRun);
  }

  // Claim the due occurrence and advance the schedule in the same transaction.
  async beginRun(input: {
    routineId: string;
    trigger: RoutineRunTrigger;
    skipReason?: string;
  }) {
    return await this.change(async (transaction) => {
      const routine = await readRecord(transaction, input.routineId);
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
      const lastRun =
        routine.lastRunId === undefined
          ? undefined
          : await transaction.get("routineRuns", routine.lastRunId).catch(
              (cause) =>
                new RoutineStorageError({
                  operation: "read last run",
                  cause,
                }),
            );
      if (lastRun instanceof Error) return lastRun;
      const skipReason =
        input.skipReason ??
        (lastRun?.status === "running"
          ? "The previous run is still running."
          : undefined);
      const run: WorkspaceSchema["routineRuns"] = {
        id: randomUUID(),
        routineId: routine.id,
        trigger: input.trigger,
        scheduledFor: new Date(scheduledFor).toISOString(),
        status: skipReason === undefined ? "running" : "skipped",
        startedAt: new Date(now).toISOString(),
        finishedAt:
          skipReason === undefined ? undefined : new Date(now).toISOString(),
        error: skipReason,
        sequence: routine.runSequence + 1,
      };
      transaction.set("routineRuns", run);
      transaction.set("routines", {
        ...routine,
        nextRunAt: isoTime(nextRunAt),
        runSequence: run.sequence,
        lastRunId: skipReason === undefined ? run.id : routine.lastRunId,
      });
      return toRun(run);
    });
  }

  async attachSession(input: { runId: string; sessionId: string }) {
    return await this.updateRun(input.runId, (run) => ({
      ...run,
      sessionId: input.sessionId,
    }));
  }

  // A late outcome must not overwrite an interruption or other terminal state.
  async finishRun(input: {
    runId: string;
    status: Exclude<RoutineRunStatus, "running" | "skipped">;
    error?: string;
  }) {
    const now = Date.now();
    return await this.updateRun(input.runId, (run) =>
      run.status === "running"
        ? {
            ...run,
            status: input.status,
            finishedAt: new Date(now).toISOString(),
            error: input.error,
          }
        : run,
    );
  }

  // Interrupt abandoned runs and skip occurrences missed while the process was stopped.
  async recover() {
    return await this.change(async (transaction) => {
      const now = Date.now();
      const routines = await transaction.list("routines").catch(
        (cause) =>
          new RoutineStorageError({
            operation: "read routines for recovery",
            cause,
          }),
      );
      if (routines instanceof Error) return routines;
      const runs = await transaction
        .query({ collection: "routineRuns", where: { status: "running" } })
        .catch(
          (cause) =>
            new RoutineStorageError({
              operation: "read runs for recovery",
              cause,
            }),
        );
      if (runs instanceof Error) return runs;
      for (const run of runs)
        transaction.set("routineRuns", {
          ...run,
          status: "interrupted",
          finishedAt: new Date(now).toISOString(),
          error: "Halo stopped before the run finished.",
        });
      for (const routine of routines) {
        if (!routine.enabled) continue;
        const nextRunAt = nextOccurrence({ ...routine, after: now });
        // A stored schedule that no longer resolves stays paused until edited.
        transaction.set("routines", {
          ...routine,
          nextRunAt:
            nextRunAt instanceof Error ? undefined : isoTime(nextRunAt),
        });
      }
    });
  }

  private async updateRun(
    runId: string,
    apply: (
      run: WorkspaceSchema["routineRuns"],
    ) => WorkspaceSchema["routineRuns"],
  ) {
    return await this.change(async (transaction) => {
      const run = await transaction
        .get("routineRuns", runId)
        .catch(
          (cause) => new RoutineStorageError({ operation: "read run", cause }),
        );
      if (run instanceof Error) return run;
      if (run === undefined) return;
      const updated = apply(run);
      if (updated !== run) transaction.set("routineRuns", updated);
    });
  }

  private async change<T>(
    apply: (transaction: RoutineTransaction) => Promise<T>,
  ) {
    return await this.actionQueue.run(async () => {
      const transaction = this.tandem.transact();
      await using cleanup = new errore.AsyncDisposableStack();
      cleanup.defer(async () => {
        await transaction
          .cancel()
          .catch((cause) =>
            console.warn(
              new RoutineStorageError({ operation: "cancel", cause }),
            ),
          );
      });
      const result = await apply(transaction);
      if (result instanceof Error) return result;
      // Commit consumes the transaction, including when it rejects.
      cleanup.move();
      const committed = await this.tandem
        .commit(transaction)
        .catch(
          (cause) => new RoutineStorageError({ operation: "commit", cause }),
        );
      if (committed instanceof Error) return committed;
      return result;
    });
  }
}

async function readRecord(transaction: RoutineTransaction, routineId: string) {
  const record = await transaction
    .get("routines", routineId)
    .catch(
      (cause) => new RoutineStorageError({ operation: "read routine", cause }),
    );
  return record ?? new RoutineNotFoundError({ routineId });
}

async function readRoutine(
  database: Pick<DatabaseService["tandem"], "query">,
  routineId: string,
) {
  const records = await database
    .query({ ...routineQuery, where: { id: routineId } })
    .catch((cause) => new RoutineStorageError({ operation: "get", cause }));
  if (records instanceof Error) return records;
  const record = records[0];
  return record === undefined
    ? new RoutineNotFoundError({ routineId })
    : toRoutine(record);
}

function toRoutine(record: RoutineWithRun): Routine {
  return {
    id: record.id,
    extensionId: record.extensionId,
    name: record.name,
    cron: record.cron,
    timezone: record.timezone,
    action: record.action,
    enabled: record.enabled,
    autoArchiveSession: record.autoArchiveSession,
    nextRunAt: record.nextRunAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastRun: record.lastRun === null ? undefined : toRun(record.lastRun),
  };
}

function toRun(record: RoutineRun): RoutineRun {
  return {
    id: record.id,
    routineId: record.routineId,
    trigger: record.trigger,
    scheduledFor: record.scheduledFor,
    sessionId: record.sessionId,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
  };
}

// Returns the first occurrence strictly after `after`, in epoch milliseconds.
function nextOccurrence(input: {
  cron: string;
  timezone: string;
  after: number;
}) {
  const next = errore.try({
    try: () =>
      new Cron(input.cron, { timezone: input.timezone, paused: true }).nextRun(
        new Date(input.after),
      ),
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
  if (
    input.extensionId !== undefined &&
    !extensionIdPattern.test(input.extensionId)
  )
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

function scheduledOccurrence(input: {
  routine: Pick<Routine, "enabled" | "nextRunAt">;
  now: number;
}) {
  if (!input.routine.enabled || input.routine.nextRunAt === undefined) return;
  const nextRunAt = Date.parse(input.routine.nextRunAt);
  if (nextRunAt > input.now) return;
  return nextRunAt;
}

function isoTime(time: number | undefined) {
  return time === undefined ? undefined : new Date(time).toISOString();
}
