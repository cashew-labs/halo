import { type AutomationInput } from "@get-halo/client";
import { Logger } from "@get-halo/logger";
import { afterEach, beforeEach, expect, vi } from "vitest";
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
