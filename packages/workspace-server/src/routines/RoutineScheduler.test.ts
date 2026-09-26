import { Logger } from "@get-halo/logger";
import type { RoutineInput } from "@get-halo/client";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { routineTest } from "./fixtures.test.js";
import { RoutineScheduler } from "./RoutineScheduler.js";
import type { RoutineService } from "./RoutineService.js";

const everyTwoMinutes: RoutineInput = {
  extensionId: "appointments",
  name: "Book haircut",
  cron: "*/2 * * * *",
  timezone: "UTC",
  action: { type: "runScript", command: "./book.sh haircut" },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-09-25T08:00:30Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// Claims each scheduled occurrence and finishes it at once, standing in for script or agent work.
function startScheduler(routines: RoutineService) {
  const scheduler = new RoutineScheduler({
    routines,
    runner: {
      start: async (input) => {
        const run = await routines.beginRun(input);
        if (run instanceof Error || run === undefined) return run;
        await routines.finishRun({ runId: run.id, status: "completed" });
        return run;
      },
    },
    logger: new Logger(),
  });
  return scheduler;
}

async function scheduledTimes(routines: RoutineService, routineId: string) {
  const runs = await routines.listRuns({ routineId });
  if (runs instanceof Error) throw runs;
  return runs.map((run) => run.scheduledFor).toReversed();
}

routineTest(
  "runs each routine at its scheduled times",
  async ({ openRoutines }) => {
    const routines = await openRoutines();
    const saved = await routines.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    const scheduler = startScheduler(routines);
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(89_000);
    expect(await scheduledTimes(routines, saved.id)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await scheduledTimes(routines, saved.id)).toEqual([
      "2026-09-25T08:02:00.000Z",
    ]);

    // A routine added later joins the same timer.
    const hourly = await routines.save({
      ...everyTwoMinutes,
      name: "Book tennis lesson",
      cron: "3 * * * *",
    });
    if (hourly instanceof Error) throw hourly;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await scheduledTimes(routines, saved.id)).toEqual([
      "2026-09-25T08:02:00.000Z",
      "2026-09-25T08:04:00.000Z",
    ]);
    expect(await scheduledTimes(routines, hourly.id)).toEqual([
      "2026-09-25T08:03:00.000Z",
    ]);
    await scheduler.stop();
  },
);

routineTest(
  "paused routines do not run until resumed",
  async ({ openRoutines }) => {
    const routines = await openRoutines();
    const saved = await routines.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    const scheduler = startScheduler(routines);
    await scheduler.start();

    await routines.setEnabled({ routineId: saved.id, enabled: false });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await scheduledTimes(routines, saved.id)).toEqual([]);

    await routines.setEnabled({ routineId: saved.id, enabled: true });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(await scheduledTimes(routines, saved.id)).toEqual([
      "2026-09-25T08:12:00.000Z",
    ]);
    await scheduler.stop();
  },
);

routineTest(
  "a restarted scheduler skips occurrences missed while stopped",
  async ({ openRoutines }) => {
    const routines = await openRoutines();
    const saved = await routines.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    const before = startScheduler(routines);
    await before.start();
    await vi.advanceTimersByTimeAsync(90_000);
    await before.stop();

    await vi.advanceTimersByTimeAsync(7 * 60_000);
    const after = startScheduler(await openRoutines());
    await after.start();
    await vi.advanceTimersByTimeAsync(0);
    const restarted = await openRoutines();
    expect(await scheduledTimes(restarted, saved.id)).toEqual([
      "2026-09-25T08:02:00.000Z",
    ]);
    expect(restarted.get(saved.id)).toMatchObject({
      nextRunAt: "2026-09-25T08:10:00.000Z",
    });
    await after.stop();
  },
);

routineTest(
  "waits for occurrences beyond the timer limit",
  async ({ openRoutines }) => {
    const routines = await openRoutines();
    const saved = await routines.save({
      ...everyTwoMinutes,
      cron: "0 0 1 1 *",
    });
    if (saved instanceof Error) throw saved;
    const scheduler = startScheduler(routines);
    await scheduler.start();

    // More than three timer limits away.
    await vi.advanceTimersByTimeAsync(
      Date.parse("2026-12-31T23:59:00Z") - Date.now(),
    );
    expect(await scheduledTimes(routines, saved.id)).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await scheduledTimes(routines, saved.id)).toEqual([
      "2027-01-01T00:00:00.000Z",
    ]);
    await scheduler.stop();
  },
);
