import { type RoutineInput } from "@get-halo/client";
import { Logger } from "@get-halo/logger";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { AbortFailedError } from "../agent/Thread.js";
import { routineTest } from "./fixtures.test.js";
import { AutomationRunner } from "../automations/AutomationRunner.js";
import { RoutineNotFoundError } from "./RoutineService.js";

const everyTwoMinutes: RoutineInput = {
  extensionId: "appointments",
  name: "Book haircut",
  cron: "*/2 * * * *",
  timezone: "UTC",
  action: { type: "runScript", command: "./book.sh haircut" },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-25T08:00:30Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

routineTest(
  "a scheduled run claims its occurrence and queues overlapping runs",
  async ({ openRoutines }) => {
    const routines = await openRoutines();
    const saved = await routines.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;

    expect(
      await routines.beginRun({ routineId: saved.id, trigger: "schedule" }),
    ).toBeUndefined();

    vi.setSystemTime(new Date("2026-09-25T08:02:01Z"));
    const run = await routines.beginRun({
      routineId: saved.id,
      trigger: "schedule",
    });
    if (run instanceof Error || run === undefined) throw new Error("No run");
    await routines.automations.claimNext();
    expect(run).toMatchObject({
      status: "queued",
      scheduledFor: "2026-09-25T08:02:00.000Z",
    });
    await routines.automations.claimNext();
    await routines.attachSession({ runId: run.id, sessionId: "session-1" });

    const overlap = await routines.beginRun({
      routineId: saved.id,
      trigger: "manual",
    });
    expect(overlap).toMatchObject({
      status: "queued",
    });
    expect(routines.get(saved.id)).toMatchObject({
      nextRunAt: "2026-09-25T08:04:00.000Z",
      lastRun: { status: "queued" },
    });
    expect((await openRoutines()).get(saved.id)).toMatchObject({
      lastRun: { status: "queued" },
    });

    await routines.finishRun({ runId: run.id, status: "completed" });
    const history = await routines.listRuns({ routineId: saved.id });
    expect(history).toMatchObject([
      { status: "queued", trigger: "manual" },
      { status: "completed", trigger: "schedule", sessionId: "session-1" },
    ]);
    expect(routines.get(saved.id)).toMatchObject({
      lastRun: { status: "queued" },
    });
  },
);

routineTest(
  "reopening interrupts unfinished runs and skips missed occurrences",
  async ({ openRoutines }) => {
    const before = await openRoutines();
    const saved = await before.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    vi.setSystemTime(new Date("2026-09-25T08:02:00Z"));
    const run = await before.beginRun({
      routineId: saved.id,
      trigger: "schedule",
    });
    if (run instanceof Error || run === undefined) throw new Error("No run");

    await before.automations.claimNext();
    vi.setSystemTime(new Date("2026-09-25T08:09:10Z"));
    const after = await openRoutines();
    await after.recover();
    await after.finishRun({ runId: run.id, status: "completed" });

    expect(after.get(saved.id)).toMatchObject({
      nextRunAt: "2026-09-25T08:10:00.000Z",
      lastRun: { id: run.id, status: "interrupted" },
    });
    expect(await after.listRuns({ routineId: saved.id })).toMatchObject([
      { id: run.id, status: "interrupted" },
    ]);
  },
);

routineTest(
  "recovery aborts attached routine sessions before interrupting their runs",
  async ({ openRoutines }) => {
    const routines = await openRoutines();
    const saved = await routines.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    const run = await routines.beginRun({
      routineId: saved.id,
      trigger: "manual",
    });
    if (run instanceof Error || run === undefined) throw new Error("No run");
    await routines.automations.claimNext();
    await routines.attachSession({ runId: run.id, sessionId: "session-1" });
    const abortError = new AbortFailedError({
      reason: "abort failed",
      cause: new Error("abort failed"),
    });
    const failedRunner = new AutomationRunner({
      automations: routines.automations,
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
    expect(routines.get(saved.id)).toMatchObject({
      lastRun: { status: "running" },
    });

    const abort = vi.fn(async () => {
      expect(routines.get(saved.id)).toMatchObject({
        lastRun: { status: "running" },
      });
    });
    const runner = new AutomationRunner({
      automations: routines.automations,
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
    expect(routines.get(saved.id)).toMatchObject({
      lastRun: { status: "interrupted" },
    });
  },
);

routineTest(
  "keeps an overdue occurrence after a managed workspace wakes",
  async ({ openRoutines }) => {
    const before = await openRoutines();
    const saved = await before.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    vi.setSystemTime(new Date("2026-09-25T08:05:00Z"));
    const after = await openRoutines();
    const recovered = await after.recover({ preserveDue: true });
    if (recovered instanceof Error) throw recovered;
    expect(after.get(saved.id)).toMatchObject({
      nextRunAt: "2026-09-25T08:02:00.000Z",
    });
    const run = await after.beginRun({
      routineId: saved.id,
      trigger: "schedule",
    });
    expect(run).toMatchObject({
      scheduledFor: "2026-09-25T08:02:00.000Z",
    });
    expect(
      await after.beginRun({ routineId: saved.id, trigger: "schedule" }),
    ).toBeUndefined();
  },
);

routineTest(
  "editing and removing a routine publishes the change",
  async ({ openRoutines }) => {
    const routines = await openRoutines();
    const saved = await routines.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    const controller = new AbortController();
    const updates = routines.watch(controller.signal);
    expect((await updates.next()).value).toEqual([saved]);

    const edited = await routines.save({
      ...everyTwoMinutes,
      id: saved.id,
      name: "Book tennis lesson",
    });
    expect((await updates.next()).value).toEqual([edited]);

    await routines.remove(saved.id);
    expect((await updates.next()).value).toEqual([]);
    expect(await routines.listRuns({ routineId: saved.id })).toEqual(
      new RoutineNotFoundError({ routineId: saved.id }),
    );
    controller.abort();
  },
);
