import { InvalidRoutineError, type RoutineInput } from "@get-halo/client";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { routineTest } from "./fixtures.test.js";
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
  "schedules a routine in its time zone",
  async ({ openRoutines }) => {
    const routines = await openRoutines();

    const saved = await routines.save({
      ...everyTwoMinutes,
      name: "  Morning briefing ",
      cron: "0  8 * * *",
      timezone: "America/New_York",
      action: { type: "runAgent", prompt: "Summarize my inbox" },
    });

    expect(saved).toMatchObject({
      name: "Morning briefing",
      cron: "0 8 * * *",
      enabled: true,
      // 8:00 AM EDT later that morning.
      nextRunAt: "2026-09-25T12:00:00.000Z",
    });
    expect(routines.list()).toEqual([saved]);
  },
);

routineTest("rejects routines that cannot run", async ({ openRoutines }) => {
  const routines = await openRoutines();

  for (const input of [
    { ...everyTwoMinutes, cron: "* * * * * *" },
    { ...everyTwoMinutes, cron: "0 0 30 2 *" },
    { ...everyTwoMinutes, timezone: "Mars/Olympus" },
    { ...everyTwoMinutes, extensionId: "../elsewhere" },
    {
      ...everyTwoMinutes,
      action: { type: "runScript" as const, command: "ls", cwd: "../.." },
    },
    { ...everyTwoMinutes, action: { type: "runAgent" as const, prompt: " " } },
  ]) {
    expect(await routines.save(input)).toBeInstanceOf(InvalidRoutineError);
  }
  expect(await routines.save({ ...everyTwoMinutes, id: "missing" })).toEqual(
    new RoutineNotFoundError({ routineId: "missing" }),
  );
  expect(routines.list()).toEqual([]);
});

routineTest(
  "pausing stops the schedule and resuming restarts it from now",
  async ({ openRoutines }) => {
    const routines = await openRoutines();
    const saved = await routines.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;

    const paused = await routines.setEnabled({
      routineId: saved.id,
      enabled: false,
    });
    expect(paused).toMatchObject({ enabled: false, nextRunAt: undefined });

    vi.setSystemTime(new Date("2026-09-25T09:15:00Z"));
    expect(
      await routines.beginRun({ routineId: saved.id, trigger: "schedule" }),
    ).toBeUndefined();

    const resumed = await routines.setEnabled({
      routineId: saved.id,
      enabled: true,
    });
    expect(resumed).toMatchObject({
      enabled: true,
      nextRunAt: "2026-09-25T09:16:00.000Z",
    });
  },
);

routineTest(
  "a scheduled run claims its occurrence and skips overlapping runs",
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
    expect(run).toMatchObject({
      status: "running",
      scheduledFor: "2026-09-25T08:02:00.000Z",
    });
    await routines.attachSession({ runId: run.id, sessionId: "session-1" });

    const overlap = await routines.beginRun({
      routineId: saved.id,
      trigger: "manual",
    });
    expect(overlap).toMatchObject({
      status: "skipped",
      error: "The previous run is still running.",
    });
    expect(routines.get(saved.id)).toMatchObject({
      nextRunAt: "2026-09-25T08:04:00.000Z",
      lastRun: { id: run.id, status: "running", sessionId: "session-1" },
    });
    expect((await openRoutines()).get(saved.id)).toMatchObject({
      lastRun: { id: run.id, status: "running" },
    });

    await routines.finishRun({ runId: run.id, status: "completed" });
    const history = await routines.listRuns({ routineId: saved.id });
    expect(history).toMatchObject([
      { status: "skipped", trigger: "manual" },
      { status: "completed", trigger: "schedule", sessionId: "session-1" },
    ]);
    expect(routines.get(saved.id)).toMatchObject({
      lastRun: { id: run.id, status: "completed" },
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
