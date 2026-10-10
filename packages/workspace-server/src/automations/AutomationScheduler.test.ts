import { Logger } from "@get-halo/logger";
import type { AutomationInput } from "@get-halo/client";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { automationTest } from "./fixtures.test.js";
import { AutomationScheduler } from "./AutomationScheduler.js";
import type { AutomationService } from "./AutomationService.js";

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
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-09-25T08:00:30Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// Claims each scheduled occurrence and finishes it at once, standing in for script or agent work.
function startScheduler(automations: AutomationService) {
  const scheduler = new AutomationScheduler({
    automations: automations,
    runner: {
      start: async (input) => {
        const run = await automations.beginRun(input);
        if (run instanceof Error || run === undefined) return run;
        await automations.finishRun({ runId: run.id, status: "completed" });
        return run;
      },
    },
    logger: new Logger(),
  });
  return scheduler;
}

async function scheduledTimes(
  automations: AutomationService,
  automationId: string,
) {
  const runs = await automations.listRuns({ automationId });
  if (runs instanceof Error) throw runs;
  return runs.map((run) => run.scheduledFor).toReversed();
}

automationTest(
  "runs each routine at its scheduled times",
  async ({ openAutomations }) => {
    const automations = await openAutomations();
    const saved = await automations.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    const scheduler = startScheduler(automations);
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(89_000);
    expect(await scheduledTimes(automations, saved.id)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await scheduledTimes(automations, saved.id)).toEqual([
      "2026-09-25T08:02:00.000Z",
    ]);

    // A routine added later joins the same timer.
    const hourly = await automations.save({
      ...everyTwoMinutes,
      name: "Book tennis lesson",
      activation: {
        type: "routine",
        schedule: { cron: "3 * * * *", timezone: "UTC" },
      },
    });
    if (hourly instanceof Error) throw hourly;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await scheduledTimes(automations, saved.id)).toEqual([
      "2026-09-25T08:02:00.000Z",
      "2026-09-25T08:04:00.000Z",
    ]);
    expect(await scheduledTimes(automations, hourly.id)).toEqual([
      "2026-09-25T08:03:00.000Z",
    ]);
    await scheduler.stop();
  },
);

automationTest(
  "a restarted scheduler skips occurrences missed while stopped",
  async ({ openAutomations }) => {
    const automations = await openAutomations();
    const saved = await automations.save(everyTwoMinutes);
    if (saved instanceof Error) throw saved;
    const before = startScheduler(automations);
    await before.start();
    await vi.advanceTimersByTimeAsync(90_000);
    await before.stop();

    await vi.advanceTimersByTimeAsync(7 * 60_000);
    const afterRoutines = await openAutomations();
    await afterRoutines.recover();
    const after = startScheduler(afterRoutines);
    await after.start();
    await vi.advanceTimersByTimeAsync(0);
    const restarted = await openAutomations();
    expect(await scheduledTimes(restarted, saved.id)).toEqual([
      "2026-09-25T08:02:00.000Z",
    ]);
    expect(restarted.get(saved.id)).toMatchObject({
      nextRunAt: "2026-09-25T08:10:00.000Z",
    });
    await after.stop();
  },
);
