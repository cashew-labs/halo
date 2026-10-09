import * as errore from "errore";
import { Logger } from "@get-halo/logger";
import type { AutomationInput } from "@get-halo/client";
import { expect, vi } from "vitest";
import { routineTest } from "../../routines/fixtures.test.js";
import {
  AutomationScheduleSync,
  type AutomationScheduleSnapshot,
} from "../AutomationScheduleSync.js";

const schedule: AutomationInput = {
  name: "Daily report",
  activation: {
    type: "routine",
    schedule: { cron: "0 9 * * *", timezone: "UTC" },
  },
  action: { type: "runScript", command: "printf report" },
};

routineTest(
  "reports initial eligible schedules and coalesces saves while a snapshot is in flight",
  async ({ openRoutines }) => {
    const automations = (await openRoutines()).automations;
    const active = await automations.save(schedule);
    if (active instanceof Error) throw active;
    const paused = await automations.save({
      ...schedule,
      name: "Paused",
      enabled: false,
    });
    if (paused instanceof Error) throw paused;
    const trigger = await automations.save({
      ...schedule,
      name: "Incoming",
      activation: { type: "trigger", trigger: { type: "webhook" } },
    });
    if (trigger instanceof Error) throw trigger;
    const reports: AutomationScheduleSnapshot[] = [];
    const first = Promise.withResolvers<void>();
    const sync = new AutomationScheduleSync({
      automations,
      logger: new Logger(),
      report: async (snapshot) => {
        reports.push(snapshot);
        if (reports.length === 1) await first.promise;
      },
    });
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      first.resolve();
      await sync.stop();
    });
    sync.start();
    expect(reports).toEqual([
      { automations: [{ id: active.id, nextRunAt: active.nextRunAt }] },
    ]);
    const added = await automations.save({
      ...schedule,
      name: "Second report",
    });
    if (added instanceof Error) throw added;
    const disabled = await automations.save({ ...active, enabled: false });
    if (disabled instanceof Error) throw disabled;
    expect(reports).toHaveLength(1);
    first.resolve();
    await expect
      .poll(() => reports.at(-1))
      .toEqual({ automations: [{ id: added.id, nextRunAt: added.nextRunAt }] });
    const removed = await automations.remove(added.id);
    if (removed instanceof Error) throw removed;
    await expect.poll(() => reports.at(-1)).toEqual({ automations: [] });
  },
);

routineTest(
  "retries failed snapshots on the awake interval and aborts in-flight reporting at stop",
  async ({ openRoutines }) => {
    const automations = (await openRoutines()).automations;
    const active = await automations.save(schedule);
    if (active instanceof Error) throw active;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(() => vi.useRealTimers());
    const reports: AutomationScheduleSnapshot[] = [];
    const signals: AbortSignal[] = [];
    const sync = new AutomationScheduleSync({
      automations,
      logger: new Logger(),
      report: async (snapshot, signal) => {
        reports.push(snapshot);
        signals.push(signal);
        if (reports.length === 1)
          return new Error("Control plane temporarily unavailable");
        if (reports.length === 3) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return new Error("Report stopped");
        }
      },
    });
    cleanup.defer(async () => await sync.stop());
    sync.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual({
      automations: [{ id: active.id, nextRunAt: active.nextRunAt }],
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reports).toHaveLength(3);
    await sync.stop();
    expect(signals[2]?.aborted).toBe(true);
    const saved = await automations.save({ ...schedule, name: "After stop" });
    if (saved instanceof Error) throw saved;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports).toHaveLength(3);
  },
);
