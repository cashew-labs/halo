import {
  automationRunSelect,
  type AutomationEvent,
  type AutomationInput,
} from "@get-halo/client";
import { Logger } from "@get-halo/logger";
import { afterEach, beforeEach, expect, vi } from "vitest";
import * as errore from "errore";
import { AbortFailedError } from "../agent/Thread.js";
import { automationTest } from "./fixtures.test.js";
import { AutomationRunner } from "../automations/AutomationRunner.js";
import { AutomationNotFoundError } from "./AutomationService.js";

const everyTwoMinutes: AutomationInput = {
  extensionId: "appointments",
  name: "Book haircut",
  activation: {
    type: "routine",
    schedule: { cron: "*/2 * * * *", timezone: "UTC" },
  },
  action: { type: "runScript", command: "./book.sh haircut" },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-25T08:00:30Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

automationTest(
  "a scheduled run claims its occurrence and queues overlapping runs",
  async ({ openAutomations }) => {
    const automations = await openAutomations();
    const saved = await automations.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;

    expect(
      await automations.beginRun({
        automationId: saved.id,
        trigger: "schedule",
      }),
    ).toBeUndefined();

    vi.setSystemTime(new Date("2026-09-25T08:02:01Z"));
    const run = await automations.beginRun({
      automationId: saved.id,
      trigger: "schedule",
    });
    if (run instanceof Error || run === undefined) throw new Error("No run");
    await automations.claimNext();
    expect(run).toMatchObject({
      status: "queued",
      scheduledFor: "2026-09-25T08:02:00.000Z",
    });
    await automations.claimNext();
    await automations.attachSession({ runId: run.id, sessionId: "session-1" });

    const overlap = await automations.beginRun({
      automationId: saved.id,
      trigger: "manual",
    });
    expect(overlap).toMatchObject({
      status: "queued",
    });
    expect(automations.get(saved.id)).toMatchObject({
      nextRunAt: "2026-09-25T08:04:00.000Z",
      lastRun: { status: "queued" },
    });
    expect((await openAutomations()).get(saved.id)).toMatchObject({
      lastRun: { status: "queued" },
    });

    await automations.finishRun({ runId: run.id, status: "completed" });
    const history = await automations.listRuns({ automationId: saved.id });
    expect(history).toMatchObject([
      { status: "queued", trigger: "manual" },
      { status: "completed", trigger: "schedule", sessionId: "session-1" },
    ]);
    expect(automations.get(saved.id)).toMatchObject({
      lastRun: { status: "queued" },
    });
  },
);

automationTest(
  "reopening interrupts unfinished runs and skips missed occurrences",
  async ({ openAutomations }) => {
    const before = await openAutomations();
    const saved = await before.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    vi.setSystemTime(new Date("2026-09-25T08:02:00Z"));
    const run = await before.beginRun({
      automationId: saved.id,
      trigger: "schedule",
    });
    if (run instanceof Error || run === undefined) throw new Error("No run");

    await before.claimNext();
    vi.setSystemTime(new Date("2026-09-25T08:09:10Z"));
    const after = await openAutomations();
    await after.recover();
    await after.finishRun({ runId: run.id, status: "completed" });

    expect(after.get(saved.id)).toMatchObject({
      nextRunAt: "2026-09-25T08:10:00.000Z",
      lastRun: { id: run.id, status: "interrupted" },
    });
    expect(await after.listRuns({ automationId: saved.id })).toMatchObject([
      { id: run.id, status: "interrupted" },
    ]);
  },
);

automationTest(
  "a failed mixed automation transaction leaves definitions, generation, schedule, and subscribers unchanged",
  async ({ openAutomations, db }) => {
    const service = await openAutomations();
    const saved = await service.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    const queued = await service.beginRun({
      automationId: saved.id,
      trigger: "manual",
    });
    if (queued instanceof Error || queued === undefined)
      throw new Error("No run");
    const runs = await db.query({
      collection: "automationRuns",
      where: { id: queued.id },
    });
    const run = runs[0];
    if (run === undefined) throw new Error("No stored run");
    const before = await service.registrationSnapshot();
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    await using tx = db.useTransaction();
    await tx.update("automations", saved.id, (record) => ({
      ...record,
      revision: 99,
      nextRunAt: 0,
    }));
    await tx.update("automationSync", "1", (record) => ({
      ...record,
      generation: 99,
    }));
    // The persisted insertion sequence is unique, just like event IDs.
    tx.set("automationRuns", { ...run, id: "duplicate-sequence" });
    await expect(db.commit(tx)).rejects.toThrow();
    expect(await service.registrationSnapshot()).toEqual(before);
    expect((await openAutomations()).get(saved.id)).toMatchObject({
      revision: saved.revision,
      nextRunAt: saved.nextRunAt,
      lastRun: { id: queued.id },
    });
    expect(await db.query({ collection: "automationRuns" })).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  },
);

automationTest(
  "queue-capacity rejection does not advance a due schedule",
  async ({ openAutomations, db }) => {
    const service = await openAutomations();
    const saved = await service.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    await using tx = db.useTransaction();
    for (let sequence = 1; sequence <= 1000; sequence++) {
      tx.set("automationRuns", {
        id: `queued-${sequence}`,
        automationId: saved.id,
        revision: saved.revision,
        trigger: "manual",
        scheduledFor: Date.now(),
        status: "queued",
        startedAt: Date.now(),
        sequence,
        snapshot: saved,
      });
    }
    await tx.update("automationSync", "1", (record) => ({
      ...record,
      nextRunSequence: 1001,
    }));
    await db.commit(tx);
    vi.setSystemTime(new Date("2026-09-25T08:02:01Z"));
    expect(
      await service.beginRun({ automationId: saved.id, trigger: "schedule" }),
    ).toMatchObject({ reason: "Automation queue is full; retry later" });
    expect((await openAutomations()).get(saved.id)).toMatchObject({
      nextRunAt: saved.nextRunAt,
    });
    expect(
      await db.query({ collection: "automationRuns", select: { id: true } }),
    ).toHaveLength(1000);
    expect(await db.query({ collection: "automationSync" })).toEqual([
      { id: "1", generation: 2, nextRunSequence: 1001 },
    ]);
  },
);

automationTest(
  "recovery aborts attached routine sessions before interrupting their runs",
  async ({ openAutomations }) => {
    const automations = await openAutomations();
    const saved = await automations.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    const run = await automations.beginRun({
      automationId: saved.id,
      trigger: "manual",
    });
    if (run instanceof Error || run === undefined) throw new Error("No run");
    await automations.claimNext();
    await automations.attachSession({ runId: run.id, sessionId: "session-1" });
    const abortError = new AbortFailedError({
      reason: "abort failed",
      cause: new Error("abort failed"),
    });
    const failedRunner = new AutomationRunner({
      automations: automations,
      sessions: {
        abort: async () => abortError,
        new: vi.fn(),
        setName: vi.fn(),
        appendMessages: vi.fn(),
        prompt: vi.fn(),
        wait: vi.fn(),
        markDone: vi.fn(),
      },
      filesystem: { stat: vi.fn() },
      workspaceRoot: "/workspace",
      logger: new Logger(),
    });

    expect(await failedRunner.recover()).toBe(abortError);
    expect(automations.get(saved.id)).toMatchObject({
      lastRun: { status: "running" },
    });

    const abort = vi.fn(async () => {
      expect(automations.get(saved.id)).toMatchObject({
        lastRun: { status: "running" },
      });
    });
    const runner = new AutomationRunner({
      automations: automations,
      sessions: {
        abort,
        new: vi.fn(),
        markDone: vi.fn(),
        setName: vi.fn(),
        appendMessages: vi.fn(),
        prompt: vi.fn(),
        wait: vi.fn(),
      },
      filesystem: { stat: vi.fn() },
      workspaceRoot: "/workspace",
      logger: new Logger(),
    });

    const recovered = await runner.recover();

    expect(recovered).toBeUndefined();
    expect(abort).toHaveBeenCalledWith("session-1");
    expect(abort).toHaveBeenCalledOnce();
    expect(automations.get(saved.id)).toMatchObject({
      lastRun: { status: "interrupted" },
    });
  },
);

automationTest(
  "keeps an overdue occurrence after a managed workspace wakes",
  async ({ openAutomations }) => {
    const before = await openAutomations();
    const saved = await before.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    vi.setSystemTime(new Date("2026-09-25T08:05:00Z"));
    const after = await openAutomations();
    const recovered = await after.recover({ preserveDue: true });
    if (recovered instanceof Error) throw recovered;
    expect(after.get(saved.id)).toMatchObject({
      nextRunAt: "2026-09-25T08:02:00.000Z",
    });
    const run = await after.beginRun({
      automationId: saved.id,
      trigger: "schedule",
    });
    expect(run).toMatchObject({
      scheduledFor: "2026-09-25T08:02:00.000Z",
    });
    expect(
      await after.beginRun({ automationId: saved.id, trigger: "schedule" }),
    ).toBeUndefined();
  },
);

automationTest(
  "editing and removing a routine publishes the change",
  async ({ openAutomations }) => {
    const automations = await openAutomations();
    const saved = await automations.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    const controller = new AbortController();
    const updates = automations.watch(controller.signal);
    expect((await updates.next()).value).toEqual([saved]);

    const edited = await automations.save({
      ...everyTwoMinutes,
      id: saved.id,
      name: "Book tennis lesson",
    });
    expect((await updates.next()).value).toEqual([edited]);

    await automations.remove(saved.id);
    expect((await updates.next()).value).toEqual([]);
    expect(await automations.listRuns({ automationId: saved.id })).toEqual(
      new AutomationNotFoundError({ automationId: saved.id }),
    );
    controller.abort();
  },
);

automationTest(
  "definition edits publish one committed revision with cancelled queued runs and a new generation",
  async ({ openAutomations, db }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const service = await openAutomations();
    const saved = await service.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    const queued = await service.beginRun({
      automationId: saved.id,
      trigger: "manual",
    });
    if (queued instanceof Error || queued === undefined)
      throw new Error("No run");
    const query = {
      collection: "automations",
      where: { id: saved.id },
      with: { runs: { select: automationRunSelect } },
    } as const;
    const updates: { revision: number; statuses: string[] }[] = [];
    const subscription = await db.subscribe(query, (records) => {
      for (const record of records)
        updates.push({
          revision: record.revision,
          statuses: record.runs.map((run) => run.status),
        });
    });
    cleanup.defer(subscription.destroy);
    const edited = await service.save({
      ...everyTwoMinutes,
      id: saved.id,
      name: "Revised action",
    });
    if (edited instanceof Error) throw edited;
    expect(edited).toMatchObject({
      revision: 2,
      lastRun: { id: queued.id, status: "cancelled" },
    });
    expect(await service.registrationSnapshot()).toMatchObject({
      generation: 3,
      automations: [{ id: saved.id, revision: 2 }],
    });
    await expect
      .poll(() => updates.at(-1))
      .toEqual({ revision: 2, statuses: ["cancelled"] });
    expect(
      updates.every(
        (update) => update.revision === 2 && update.statuses[0] === "cancelled",
      ),
    ).toBe(true);
    expect(await service.claimNext()).toBeUndefined();
    expect(
      await service.setEnabled({ automationId: saved.id, enabled: true }),
    ).toEqual(edited);
    expect(await service.registrationSnapshot()).toMatchObject({
      generation: 3,
    });
    await service.setEnabled({ automationId: saved.id, enabled: false });
    expect(await service.registrationSnapshot()).toMatchObject({
      generation: 4,
      automations: [{ revision: 3, enabled: false }],
    });
    await service.remove(saved.id);
    expect(
      await db.query({
        collection: "automationRuns",
        where: { automationId: saved.id },
      }),
    ).toEqual([]);
    expect(await service.registrationSnapshot()).toEqual({
      generation: 5,
      automations: [],
    });
  },
);

automationTest(
  "Tandem writes update synchronous consumers and legacy watch until the service closes",
  async ({ openAutomations, db }) => {
    const service = await openAutomations();
    const saved = await service.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    const controller = new AbortController();
    const updates = service.watch(controller.signal);
    expect((await updates.next()).value).toEqual([saved]);
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    await using tx = db.useTransaction();
    await tx.update("automations", saved.id, (record) => ({
      ...record,
      name: "Changed through Tandem",
    }));
    await db.commit(tx);
    await expect
      .poll(() => service.get(saved.id))
      .toMatchObject({ name: "Changed through Tandem" });
    expect((await updates.next()).value).toMatchObject([
      { name: "Changed through Tandem" },
    ]);
    expect(listener).toHaveBeenCalledOnce();
    controller.abort();
    await updates.return();
    unsubscribe();
    await service.close();
    await using afterClose = db.useTransaction();
    await afterClose.update("automations", saved.id, (record) => ({
      ...record,
      name: "After close",
    }));
    await db.commit(afterClose);
    expect((await openAutomations()).get(saved.id)).toMatchObject({
      name: "After close",
    });
    expect(service.get(saved.id)).toMatchObject({
      name: "Changed through Tandem",
    });
  },
);

automationTest(
  "equal-time queues keep insertion order, exclude skipped last runs, and allow only one active run per automation",
  async ({ openAutomations }) => {
    const service = await openAutomations();
    const first = await service.save(everyTwoMinutes);
    const second = await service.save({
      ...everyTwoMinutes,
      name: "Other automation",
    });
    if (first instanceof Error) throw first;
    if (second instanceof Error) throw second;
    const oldest = await service.beginRun({
      automationId: first.id,
      trigger: "manual",
    });
    const blocked = await service.beginRun({
      automationId: first.id,
      trigger: "manual",
    });
    const other = await service.beginRun({
      automationId: second.id,
      trigger: "manual",
    });
    if (oldest instanceof Error || oldest === undefined)
      throw new Error("No oldest run");
    if (blocked instanceof Error || blocked === undefined)
      throw new Error("No blocked run");
    if (other instanceof Error || other === undefined)
      throw new Error("No other run");
    await service.beginRun({
      automationId: first.id,
      trigger: "manual",
      skipReason: "Skipped",
    });
    expect(service.get(first.id)).toMatchObject({
      lastRun: { id: blocked.id },
    });
    const restarted = await openAutomations();
    expect(restarted.get(first.id)).toMatchObject({
      lastRun: { id: blocked.id },
    });
    const claims = await Promise.all([
      restarted.claimNext(),
      restarted.claimNext(),
      restarted.claimNext(),
    ]);
    expect(claims).toMatchObject([
      { run: { id: oldest.id, status: "running" } },
      { run: { id: other.id, status: "running" } },
      undefined,
    ]);
    await restarted.finishRun({ runId: oldest.id, status: "completed" });
    expect(await restarted.claimNext()).toMatchObject({
      run: { id: blocked.id, status: "running" },
    });
    expect(
      await restarted.listRuns({ automationId: first.id, limit: 2 }),
    ).toMatchObject([
      { status: "skipped" },
      { id: blocked.id, status: "running" },
    ]);
  },
);

automationTest(
  "event snapshots survive reopening and retained hashes deduplicate exact deliveries after payload removal",
  async ({ openAutomations, db }) => {
    const service = await openAutomations();
    const saved = await service.save({
      name: "Webhook",
      activation: { type: "trigger", trigger: { type: "webhook" } },
      action: { type: "runScript", command: "original command" },
    });
    if (saved instanceof Error) throw saved;
    const event: AutomationEvent = {
      eventId: "unique-delivery",
      automationId: saved.id,
      revision: saved.revision,
      source: "webhook",
      occurredAt: new Date().toISOString(),
      payload: { value: "🦉" },
    };
    const [queued, duplicate] = await Promise.all([
      service.acceptEvent(event),
      service.acceptEvent(event),
    ]);
    if (queued instanceof Error) throw queued;
    expect(duplicate).toEqual(queued);
    expect(await service.acceptEvent(event)).toEqual(queued);
    expect(
      await service.acceptEvent({ ...event, payload: { value: "different" } }),
    ).toBeInstanceOf(Error);
    vi.setSystemTime(new Date("2026-10-05T08:00:30Z"));
    expect(await service.expiredEvents()).toEqual([]);
    await service.forgetEvent({
      id: queued.id,
      payload: JSON.stringify(event),
    });
    const restarted = await openAutomations();
    expect(await restarted.claimNext()).toMatchObject({
      automation: { action: { command: "original command" } },
      event,
      run: { id: queued.id },
    });
    await restarted.save({
      name: "Webhook edited",
      id: saved.id,
      activation: { type: "trigger", trigger: { type: "webhook" } },
      action: { type: "runScript", command: "new command" },
    });
    const stored = await db.query({
      collection: "automationRuns",
      where: { id: queued.id },
    });
    expect(stored[0]?.snapshot?.action).toEqual({
      type: "runScript",
      command: "original command",
    });
    expect(await restarted.expiredEvents()).toEqual([]);
    await restarted.finishRun({ runId: queued.id, status: "completed" });
    expect(await restarted.expiredEvents()).toEqual([
      { id: queued.id, payload: JSON.stringify(event) },
    ]);
    await restarted.forgetEvent({
      id: queued.id,
      payload: JSON.stringify(event),
    });
    expect(await restarted.expiredEvents()).toEqual([]);
    expect(await restarted.acceptEvent(event)).toMatchObject({
      id: queued.id,
      status: "completed",
    });
    expect(
      await restarted.acceptEvent({
        ...event,
        payload: { value: "different" },
      }),
    ).toBeInstanceOf(Error);
    expect(
      await db.query({
        collection: "automationRuns",
        where: { id: queued.id },
      }),
    ).toMatchObject([
      {
        payload: undefined,
        snapshot: undefined,
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
  },
);
