import { type RoutineInput } from "@get-halo/client";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { routineTest } from "./fixtures.test.js";

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
