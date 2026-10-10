import { createHash, randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { Cron } from "croner";
import * as errore from "errore";
import {
  automationEventSchema,
  automationRunSelect,
  type AutomationEvent,
  type AutomationSnapshot,
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
  type WorkspaceSchema,
} from "@get-halo/client";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import { Stream } from "@get-halo/shared/Stream";
import type { DatabaseService } from "../database/DatabaseService.js";

export class AutomationNotFoundError extends errore.createTaggedError({
  name: "AutomationNotFoundError",
  message:
    "Automation '$automationId' does not exist. List automations to find its ID.",
}) {}

class AutomationStorageError extends errore.createTaggedError({
  name: "AutomationStorageError",
  message: "Automation storage failed during $operation",
}) {}

type Definition = WorkspaceSchema["automations"];
type Run = WorkspaceSchema["automationRuns"];
type RunSummary = Omit<Run, "snapshot" | "payload" | "payloadHash">;
type Transaction = ReturnType<DatabaseService["useTransaction"]>;

const extensionIdPattern = /^[a-z][a-z0-9-]*$/;
const viewQuery = {
  collection: "automations",
  orderBy: { createdAt: "asc", id: "asc" },
  with: {
    // Tandem has no not-equal or aggregate predicates. Derive the latest non-skipped
    // run from ordered metadata; execution data is never part of this view.
    runs: {
      select: automationRunSelect,
      orderBy: { startedAt: "desc", sequence: "desc" },
    },
  },
} as const;

export class AutomationService {
  // A Tandem-derived view preserves synchronous runner/scheduler consumers.
  // Commands never patch it: subscriptions and commit barriers re-query records.
  private automations: Automation[] = [];
  private readonly changes = new Stream<Automation[] | Error>();
  private readonly actionQueue = new SerialQueue();
  private readonly viewQueue = new SerialQueue();
  private destroySubscription: (() => void) | undefined;
  private closed = false;
  private readonly db: DatabaseService;

  private constructor(ctx: { db: DatabaseService }) {
    this.db = ctx.db;
  }

  static async open(ctx: { db: DatabaseService }) {
    const service = new AutomationService(ctx);
    const subscription = await ctx.db
      .subscribe(
        viewQuery,
        () => {
          void service.refresh().then(
            (result) => {
              if (result instanceof Error) {
                console.warn(result);
                service.changes.append(result);
              }
            },
            (cause) =>
              console.warn(
                new AutomationStorageError({
                  operation: "watch callback",
                  cause,
                }),
              ),
          );
        },
        {
          onError: (cause) => {
            const error = new AutomationStorageError({
              operation: "watch",
              cause,
            });
            console.warn(error);
            service.changes.append(error);
          },
        },
      )
      .catch(
        (cause) => new AutomationStorageError({ operation: "open", cause }),
      );
    if (subscription instanceof Error) return subscription;
    service.destroySubscription = subscription.destroy;
    const initial = await service.refresh();
    if (initial instanceof Error) {
      await service.close();
      return initial;
    }
    return service;
  }

  async close() {
    this.closed = true;
    this.destroySubscription?.();
    await this.actionQueue.run(() => undefined);
    await this.viewQueue.run(() => undefined);
  }

  list() {
    return this.automations;
  }

  get(automationId: string) {
    return (
      this.automations.find((item) => item.id === automationId) ??
      new AutomationNotFoundError({ automationId })
    );
  }

  subscribe(listener: (automations: Automation[]) => void) {
    return this.changes.subscribe((update) => {
      if (update instanceof Error) {
        console.warn(update);
        return;
      }
      listener(update);
    });
  }

  // Released clients still consume snapshots; current clients use Tandem sync.
  async *watch(signal: AbortSignal | undefined) {
    const initial = await this.actionQueue.run(() => ({
      automations: this.automations,
      updates: this.changes.consume({ abortSignal: signal }),
    }));
    using updates = initial.updates;
    if (signal?.aborted) return;
    yield initial.automations;
    for await (const update of updates) {
      if (update instanceof Error) throw update;
      yield update;
    }
  }

  async registrationSnapshot() {
    return await this.actionQueue.run(async () => {
      await using tx = this.db.useTransaction();
      const sync = await this.readSync(tx);
      if (sync instanceof Error) return sync;
      const definitions = await tx
        .query({ collection: "automations" })
        .catch(
          (cause) =>
            new AutomationStorageError({ operation: "snapshot", cause }),
        );
      if (definitions instanceof Error) return definitions;
      const snapshot: AutomationSnapshot = {
        generation: sync.generation,
        automations: definitions.map(
          ({ id, revision, name, activation, enabled }) => ({
            id,
            revision,
            name,
            activation,
            enabled,
          }),
        ),
      };
      // Validate read dependencies before returning a generation/definition pair.
      const read = await this.db.commit(tx).catch(
        (cause) =>
          new AutomationStorageError({
            operation: "snapshot consistency",
            cause,
          }),
      );
      if (read instanceof Error) return read;
      return snapshot;
    });
  }

  async save(input: AutomationInput) {
    const valid = validateInput(input);
    if (valid instanceof Error) return valid;
    return await this.actionQueue.run(async () => {
      await using tx = this.db.useTransaction();
      const definitions = await tx.query({ collection: "automations" }).catch(
        (cause) =>
          new AutomationStorageError({
            operation: "read before save",
            cause,
          }),
      );
      if (definitions instanceof Error) return definitions;
      const existing = definitions.find((item) => item.id === input.id);
      if (input.id !== undefined && existing === undefined)
        return new AutomationNotFoundError({ automationId: input.id });
      if (existing === undefined && definitions.length >= 1000)
        return new InvalidAutomationError({
          reason: "This workspace has reached its 1000 automation limit",
        });
      const now = Date.now();
      const enabled = input.enabled ?? existing?.enabled ?? true;
      const nextRunAt = enabled
        ? nextActivation({ activation: valid.activation, after: now })
        : undefined;
      if (nextRunAt instanceof Error) return nextRunAt;
      const definition: Definition = {
        id: existing?.id ?? randomUUID(),
        revision: (existing?.revision ?? 0) + 1,
        ...valid,
        enabled,
        autoArchiveSession:
          input.autoArchiveSession ?? existing?.autoArchiveSession ?? false,
        nextRunAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const staged = await this.changeDefinition({ tx, definition, now });
      if (staged instanceof Error) return staged;
      const saved = await this.commit(tx);
      if (saved instanceof Error) return saved;
      return this.get(definition.id);
    });
  }

  async setEnabled(input: { automationId: string; enabled: boolean }) {
    return await this.actionQueue.run(async () => {
      await using tx = this.db.useTransaction();
      const definition = await this.readDefinition({
        tx,
        automationId: input.automationId,
      });
      if (definition instanceof Error) return definition;
      if (definition.enabled === input.enabled) {
        const refreshed = await this.refresh();
        if (refreshed instanceof Error) return refreshed;
        return this.get(definition.id);
      }
      const now = Date.now();
      const nextRunAt = input.enabled
        ? nextActivation({ activation: definition.activation, after: now })
        : undefined;
      if (nextRunAt instanceof Error) return nextRunAt;
      const staged = await this.changeDefinition({
        tx,
        definition: {
          ...definition,
          enabled: input.enabled,
          revision: definition.revision + 1,
          nextRunAt,
          updatedAt: now,
        },
        now,
      });
      if (staged instanceof Error) return staged;
      const saved = await this.commit(tx);
      if (saved instanceof Error) return saved;
      return this.get(definition.id);
    });
  }

  private async changeDefinition(input: {
    tx: Transaction;
    definition: Definition;
    now: number;
  }) {
    const { tx, definition, now } = input;
    const sync = await this.readSync(tx);
    if (sync instanceof Error) return sync;
    const queued = await tx
      .query({
        collection: "automationRuns",
        where: { automationId: definition.id, status: "queued" },
      })
      .catch(
        (cause) =>
          new AutomationStorageError({
            operation: "cancel queued revisions",
            cause,
          }),
      );
    if (queued instanceof Error) return queued;
    return errore.try({
      try: () => {
        tx.set("automationSync", { ...sync, generation: sync.generation + 1 });
        tx.set("automations", definition);
        for (const run of queued)
          tx.set("automationRuns", {
            ...run,
            status: "cancelled",
            finishedAt: now,
            error: "Automation changed before execution.",
          });
      },
      catch: (cause) =>
        new AutomationStorageError({ operation: "stage definition", cause }),
    });
  }

  // Sessions stay in the workspace; remove the schedule and run index together.
  async remove(automationId: string) {
    return await this.actionQueue.run(async () => {
      await using tx = this.db.useTransaction();
      const definition = await this.readDefinition({ tx, automationId });
      if (definition instanceof Error) return definition;
      const sync = await this.readSync(tx);
      if (sync instanceof Error) return sync;
      const runs = await tx
        .query({ collection: "automationRuns", where: { automationId } })
        .catch(
          (cause) =>
            new AutomationStorageError({
              operation: "read before remove",
              cause,
            }),
        );
      if (runs instanceof Error) return runs;
      // Explicit removals keep Tandem subscribers aware of the native cascade.
      const staged = errore.try({
        try: () => {
          for (const run of runs) tx.remove("automationRuns", run.id);
          tx.remove("automations", automationId);
          tx.set("automationSync", {
            ...sync,
            generation: sync.generation + 1,
          });
        },
        catch: (cause) =>
          new AutomationStorageError({ operation: "stage remove", cause }),
      });
      if (staged instanceof Error) return staged;
      return await this.commit(tx);
    });
  }

  async listRuns(input: { automationId: string; limit?: number }) {
    const automation = this.get(input.automationId);
    if (automation instanceof Error) return automation;
    const runs = await this.db
      .query({
        collection: "automationRuns",
        where: { automationId: input.automationId },
        select: automationRunSelect,
        orderBy: { startedAt: "desc", sequence: "desc" },
        limit: input.limit ?? 50,
      })
      .catch(
        (cause) =>
          new AutomationStorageError({ operation: "list runs", cause }),
      );
    if (runs instanceof Error) return runs;
    return runs.map(runFromRecord);
  }

  async getRun(runId: string) {
    const runs = await this.db
      .query({
        collection: "automationRuns",
        where: { id: runId },
        select: automationRunSelect,
      })
      .catch(
        (cause) => new AutomationStorageError({ operation: "get run", cause }),
      );
    if (runs instanceof Error) return runs;
    if (runs[0] === undefined)
      return new InvalidAutomationError({
        reason: "Automation run does not exist",
      });
    return runFromRecord(runs[0]);
  }

  async runningSessionIds() {
    const runs = await this.db
      .query({
        collection: "automationRuns",
        where: { status: "running" },
        select: { sessionId: true },
      })
      .catch(
        (cause) =>
          new AutomationStorageError({ operation: "running sessions", cause }),
      );
    if (runs instanceof Error) return runs;
    return runs.flatMap((run) =>
      run.sessionId === undefined ? [] : [run.sessionId],
    );
  }

  async beginRun(input: {
    automationId: string;
    trigger: "manual" | "schedule";
    skipReason?: string;
    samplePayload?: AutomationEvent["payload"];
  }) {
    return await this.actionQueue.run(async () => {
      await using tx = this.db.useTransaction();
      const definition = await this.readDefinition({
        tx,
        automationId: input.automationId,
      });
      if (definition instanceof Error) return definition;
      const automation = automationFromRecord(definition);
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
          : definition.nextRunAt;
      if (nextRunAt instanceof Error) return nextRunAt;
      if (
        input.samplePayload !== undefined &&
        (input.trigger !== "manual" || automation.activation.type !== "trigger")
      )
        return new InvalidAutomationError({
          reason: "Sample input requires a manual trigger test",
        });
      const event: AutomationEvent | undefined =
        input.samplePayload === undefined ||
        automation.activation.type !== "trigger"
          ? undefined
          : {
              eventId: `test-${randomUUID()}`,
              automationId: automation.id,
              revision: automation.revision,
              source: automation.activation.trigger.type,
              occurredAt: new Date(now).toISOString(),
              payload: input.samplePayload,
            };
      const payload = errore.try({
        try: () => (event === undefined ? undefined : JSON.stringify(event)),
        catch: (cause) =>
          new InvalidAutomationError({
            reason: "Sample input must be JSON",
            cause,
          }),
      });
      if (payload instanceof Error) return payload;
      if (
        payload !== undefined &&
        (Buffer.byteLength(payload) > 270_000 ||
          !Value.Check(automationEventSchema, event))
      )
        return new InvalidAutomationError({
          reason: "Sample input must be a JSON object of at most 256 KiB",
        });
      return await this.enqueueUnqueued({
        tx,
        definition,
        automation,
        event,
        payload,
        trigger: input.trigger,
        scheduledFor,
        nextRunAt,
        skipReason: input.skipReason,
      });
    });
  }

  async expiredEvents() {
    const runs = await this.db
      .query({
        collection: "automationRuns",
        where: { startedAt: { lt: Date.now() - 7 * 24 * 60 * 60 * 1000 } },
        select: { id: true, payload: true, status: true },
      })
      .catch(
        (cause) =>
          new AutomationStorageError({ operation: "expired events", cause }),
      );
    if (runs instanceof Error) return runs;
    // No NOT/IS NULL predicates in Tandem; limit only after filtering retained payloads.
    return runs
      .flatMap((run) =>
        run.payload !== undefined &&
        run.status !== "running" &&
        run.status !== "queued"
          ? [{ id: run.id, payload: run.payload }]
          : [],
      )
      .slice(0, 1000);
  }

  async forgetEvent(input: { id: string; payload: string }) {
    return await this.updateRun({
      runId: input.id,
      apply: (run) =>
        run.status === "running" || run.status === "queued"
          ? run
          : {
              ...run,
              payloadHash: createHash("sha256")
                .update(input.payload)
                .digest("hex"),
              payload: undefined,
              snapshot: undefined,
            },
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
      await using tx = this.db.useTransaction();
      const runs = await tx
        .query({
          collection: "automationRuns",
          where: { eventId: event.eventId },
          limit: 1,
        })
        .catch(
          (cause) =>
            new AutomationStorageError({
              operation: "deduplicate event",
              cause,
            }),
        );
      if (runs instanceof Error) return runs;
      const existing = runs[0];
      if (existing !== undefined) {
        if (
          existing.automationId !== event.automationId ||
          existing.revision !== event.revision ||
          (existing.payload === undefined
            ? existing.payloadHash !==
              createHash("sha256").update(payload).digest("hex")
            : existing.payload !== payload)
        )
          return new InvalidAutomationError({
            reason: "Event ID already belongs to a different delivery",
          });
        return runFromRecord(existing);
      }
      const definition = await this.readDefinition({
        tx,
        automationId: event.automationId,
      });
      if (definition instanceof Error) return definition;
      const automation = automationFromRecord(definition);
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
        tx,
        definition,
        automation,
        trigger: "event",
        scheduledFor: Date.parse(event.occurredAt),
        event,
        payload,
      });
    });
  }

  private async enqueueUnqueued(input: {
    tx: Transaction;
    definition: Definition;
    automation: Automation;
    trigger: AutomationRunTrigger;
    scheduledFor: number;
    nextRunAt?: number;
    skipReason?: string;
    event?: AutomationEvent;
    payload?: string;
  }) {
    const { tx } = input;
    const pending = await tx
      .query({
        collection: "automationRuns",
        where: { status: "queued" },
        select: { id: true },
        limit: 1000,
      })
      .catch(
        (cause) =>
          new AutomationStorageError({ operation: "queue capacity", cause }),
      );
    if (pending instanceof Error) return pending;
    if (pending.length >= 1000)
      return new InvalidAutomationError({
        reason: "Automation queue is full; retry later",
      });
    const sync = await this.readSync(tx);
    if (sync instanceof Error) return sync;
    const now = Date.now();
    const run: Run = {
      id: randomUUID(),
      automationId: input.automation.id,
      revision: input.automation.revision,
      trigger: input.trigger,
      eventId: input.event?.eventId,
      scheduledFor: input.scheduledFor,
      status: input.skipReason === undefined ? "queued" : "skipped",
      startedAt: now,
      finishedAt: input.skipReason === undefined ? undefined : now,
      error: input.skipReason,
      sequence: sync.nextRunSequence,
      snapshot: { ...input.automation, lastRun: undefined },
      payload: input.payload,
    };
    const staged = errore.try({
      try: () => {
        tx.set("automationRuns", run);
        tx.set("automationSync", {
          ...sync,
          nextRunSequence: sync.nextRunSequence + 1,
        });
        if (input.trigger === "schedule")
          tx.set("automations", {
            ...input.definition,
            nextRunAt: input.nextRunAt,
          });
      },
      catch: (cause) =>
        new AutomationStorageError({ operation: "stage enqueue", cause }),
    });
    if (staged instanceof Error) return staged;
    const saved = await this.commit(tx);
    if (saved instanceof Error) return saved;
    return runFromRecord(run);
  }

  // One runner, plus transactional predicate reads, prevents overlapping actions.
  async claimNext() {
    return await this.actionQueue.run(async () => {
      await using tx = this.db.useTransaction();
      const active = await tx
        .query({
          collection: "automationRuns",
          where: { status: "running" },
          select: { automationId: true },
        })
        .catch(
          (cause) =>
            new AutomationStorageError({ operation: "active runs", cause }),
        );
      if (active instanceof Error) return active;
      const queued = await tx
        .query({
          collection: "automationRuns",
          where: { status: "queued" },
          select: automationRunSelect,
          orderBy: { startedAt: "asc", sequence: "asc" },
        })
        .catch(
          (cause) =>
            new AutomationStorageError({ operation: "claim queue", cause }),
        );
      if (queued instanceof Error) return queued;
      const activeIds = new Set(active.map((run) => run.automationId));
      const candidate = queued.find(
        (item) => !activeIds.has(item.automationId),
      );
      if (candidate === undefined) return;
      const run = await tx.get("automationRuns", candidate.id).catch(
        (cause) =>
          new AutomationStorageError({
            operation: "read queued action",
            cause,
          }),
      );
      if (run instanceof Error) return run;
      if (run === undefined) return;
      const definition = await this.readDefinition({
        tx,
        automationId: run.automationId,
      });
      if (definition instanceof Error) return definition;
      if (definition.revision !== run.revision)
        return new InvalidAutomationError({
          reason: "Queued automation revision no longer exists",
        });
      if (run.snapshot === undefined)
        return new InvalidAutomationError({
          reason: "Could not read queued action",
        });
      const event =
        run.payload === undefined
          ? undefined
          : errore.try({
              // SAFETY: Deliveries are schema-validated before enqueueing.
              try: () => JSON.parse(run.payload!) as AutomationEvent,
              catch: (cause) =>
                new InvalidAutomationError({
                  reason: "Could not read queued event",
                  cause,
                }),
            });
      if (event instanceof Error) return event;
      const claimed: Run = { ...run, status: "running" };
      const staged = errore.try({
        try: () => tx.set("automationRuns", claimed),
        catch: (cause) =>
          new AutomationStorageError({ operation: "stage claim", cause }),
      });
      if (staged instanceof Error) return staged;
      const saved = await this.commit(tx);
      if (saved instanceof Error) return saved;
      return { automation: run.snapshot, run: runFromRecord(claimed), event };
    });
  }

  async attachSession(input: { runId: string; sessionId: string }) {
    return await this.updateRun({
      runId: input.runId,
      apply: (run) => ({ ...run, sessionId: input.sessionId }),
    });
  }

  // A late outcome cannot replace restart interruption.
  async finishRun(input: {
    runId: string;
    status: Exclude<AutomationRunStatus, "running" | "skipped">;
    error?: string;
  }) {
    return await this.updateRun({
      runId: input.runId,
      apply: (run) =>
        run.status === "running"
          ? {
              ...run,
              status: input.status,
              finishedAt: Date.now(),
              error: input.error,
            }
          : run,
    });
  }

  async recover(options?: { preserveDue?: boolean }) {
    return await this.actionQueue.run(async () => {
      await using tx = this.db.useTransaction();
      const definitions = await tx
        .query({ collection: "automations", where: { enabled: true } })
        .catch(
          (cause) =>
            new AutomationStorageError({
              operation: "recover schedules",
              cause,
            }),
        );
      if (definitions instanceof Error) return definitions;
      const running = await tx
        .query({ collection: "automationRuns", where: { status: "running" } })
        .catch(
          (cause) =>
            new AutomationStorageError({ operation: "recover runs", cause }),
        );
      if (running instanceof Error) return running;
      const now = Date.now();
      const staged = errore.try({
        try: () => {
          for (const run of running)
            tx.set("automationRuns", {
              ...run,
              status: "interrupted",
              finishedAt: now,
              error: "Halo stopped before the run finished.",
            });
          for (const definition of definitions) {
            const nextRunAt =
              options?.preserveDue && definition.nextRunAt !== undefined
                ? definition.nextRunAt
                : nextActivation({
                    activation: definition.activation,
                    after: now,
                  });
            // A stored schedule that no longer resolves stays paused until edited.
            if (nextRunAt instanceof Error) console.warn(nextRunAt);
            tx.set("automations", {
              ...definition,
              nextRunAt: nextRunAt instanceof Error ? undefined : nextRunAt,
            });
          }
        },
        catch: (cause) =>
          new AutomationStorageError({ operation: "stage recovery", cause }),
      });
      if (staged instanceof Error) return staged;
      return await this.commit(tx);
    });
  }

  private async updateRun(input: { runId: string; apply: (run: Run) => Run }) {
    return await this.actionQueue.run(async () => {
      await using tx = this.db.useTransaction();
      const run = await tx.get("automationRuns", input.runId).catch(
        (cause) =>
          new AutomationStorageError({
            operation: "read before update run",
            cause,
          }),
      );
      if (run instanceof Error) return run;
      if (run === undefined) return;
      const updated = input.apply(run);
      if (updated === run) return;
      const staged = errore.try({
        try: () => tx.set("automationRuns", updated),
        catch: (cause) =>
          new AutomationStorageError({ operation: "stage run update", cause }),
      });
      if (staged instanceof Error) return staged;
      return await this.commit(tx);
    });
  }

  private async readSync(tx: Transaction) {
    const sync = await tx
      .get("automationSync", "1")
      .catch(
        (cause) =>
          new AutomationStorageError({ operation: "read sync", cause }),
      );
    if (sync instanceof Error) return sync;
    if (sync === undefined)
      return new AutomationStorageError({
        operation: "missing sync singleton",
      });
    return sync;
  }

  private async readDefinition(input: {
    tx: Transaction;
    automationId: string;
  }) {
    const definition = await input.tx
      .get("automations", input.automationId)
      .catch(
        (cause) =>
          new AutomationStorageError({ operation: "read definition", cause }),
      );
    if (definition instanceof Error) return definition;
    if (definition === undefined)
      return new AutomationNotFoundError({ automationId: input.automationId });
    return definition;
  }

  private async commit(tx: Transaction) {
    const saved = await this.db
      .commit(tx)
      .catch(
        (cause) => new AutomationStorageError({ operation: "commit", cause }),
      );
    if (saved instanceof Error) return saved;
    // Tandem notifications are asynchronous. The barrier makes synchronous
    // consumers see committed records before a command returns.
    return await this.refresh();
  }

  private async refresh() {
    return await this.viewQueue.run(async () => {
      if (this.closed) return;
      await using tx = this.db.useTransaction();
      const records = await tx
        .query(viewQuery)
        .catch(
          (cause) =>
            new AutomationStorageError({ operation: "refresh view", cause }),
        );
      if (records instanceof Error) return records;
      const read = await this.db.commit(tx).catch(
        (cause) =>
          new AutomationStorageError({
            operation: "view consistency",
            cause,
          }),
      );
      if (read instanceof Error) return read;
      return this.applyView(records);
    });
  }

  private applyView(records: (Definition & { runs: RunSummary[] })[]) {
    const automations: Automation[] = [];
    for (const record of records) {
      const latest = record.runs.find((run) => run.status !== "skipped");
      const automation = automationFromRecord(
        record,
        latest === undefined ? undefined : runFromRecord(latest),
      );
      if (automation instanceof Error) return automation;
      automations.push(automation);
    }
    if (JSON.stringify(automations) === JSON.stringify(this.automations))
      return;
    this.automations = automations;
    this.changes.append(automations);
  }
}

function automationFromRecord(record: Definition, lastRun?: AutomationRun) {
  if (!Value.Check(automationActionSchema, record.action))
    return new InvalidAutomationError({
      reason: `Automation '${record.id}' has an invalid action`,
    });
  if (!Value.Check(automationActivationSchema, record.activation))
    return new InvalidAutomationError({
      reason: `Automation '${record.id}' has an invalid activation`,
    });
  const {
    id,
    extensionId,
    name,
    activation,
    revision,
    action,
    enabled,
    autoArchiveSession,
  } = record;
  const automation: Automation = {
    id,
    extensionId,
    name,
    activation,
    revision,
    action,
    enabled,
    autoArchiveSession,
    nextRunAt: isoTime(record.nextRunAt),
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    lastRun,
  };
  return automation;
}

function runFromRecord(record: RunSummary): AutomationRun {
  const {
    id,
    automationId,
    revision,
    eventId,
    trigger,
    scheduledFor,
    sessionId,
    status,
    startedAt,
    finishedAt,
    error,
  } = record;
  return {
    id,
    automationId,
    revision,
    eventId,
    trigger,
    sessionId,
    status,
    error,
    scheduledFor: new Date(scheduledFor).toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: isoTime(finishedAt),
  };
}

function isoTime(time: number | undefined) {
  return time === undefined ? undefined : new Date(time).toISOString();
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
      new InvalidAutomationError({
        reason: `Invalid schedule: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
  if (next instanceof Error) return next;
  // oxlint-disable-next-line unicorn/no-null -- Cron uses null when no occurrence exists.
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

function scheduledOccurrence(input: { automation: Automation; now: number }) {
  if (!input.automation.enabled || input.automation.nextRunAt === undefined)
    return;
  const nextRunAt = Date.parse(input.automation.nextRunAt);
  if (nextRunAt > input.now) return;
  return nextRunAt;
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
