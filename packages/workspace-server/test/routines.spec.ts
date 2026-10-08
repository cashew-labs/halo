import fs from "node:fs/promises";
import path from "node:path";
import {
  sessionMessages,
  type HaloClient,
  type RoutineInput,
  type RoutineRunStatus,
} from "@get-halo/client";
import { expect } from "vitest";
import { serverTest } from "./serverTest.js";
import type { TestServer } from "./TestServer.js";

const bookHaircut: RoutineInput = {
  extensionId: "appointments",
  name: "Book haircut",
  cron: "0 8 * * *",
  timezone: "America/New_York",
  action: {
    type: "runScript",
    command: "echo booked in $(basename $PWD); echo slot 8am >&2",
  },
};

async function installExtension(server: TestServer, extensionId: string) {
  await fs.mkdir(
    path.join(server.workspaceRoot, ".halo", "extensions", extensionId),
    { recursive: true },
  );
}

async function waitForRun(
  rpc: HaloClient,
  routineId: string,
  status: RoutineRunStatus,
) {
  await expect
    .poll(async () => (await rpc.routines.listRuns({ routineId }))[0]?.status)
    .toBe(status);
  const [run] = await rpc.routines.listRuns({ routineId });
  return run!;
}

serverTest(
  "a script routine runs in a new named session",
  async ({ server }) => {
    await installExtension(server, "appointments");
    const routine = await server.rpc.routines.save(bookHaircut);

    const started = await server.rpc.routines.runNow({ routineId: routine.id });
    expect(started).toMatchObject({ trigger: "manual", status: "running" });
    const run = await waitForRun(server.rpc, routine.id, "completed");

    const snapshot = await server.rpc.thread.snapshot({
      sessionId: run.sessionId!,
    });
    expect(sessionMessages(snapshot)).toMatchObject([
      {
        role: "bashExecution",
        command: "echo booked in $(basename $PWD); echo slot 8am >&2",
        output: "booked in appointments\nslot 8am\n",
        exitCode: 0,
      },
    ]);
    const sessions = await server.rpc.thread.list();
    expect(
      sessions.find((session) => session.sessionId === run.sessionId),
    ).toMatchObject({
      title: expect.stringMatching(/^Book haircut · \w+ \d+, \d+:\d\d [AP]M$/),
    });
    expect(await server.rpc.routines.list()).toMatchObject([
      { id: routine.id, lastRun: { id: run.id, status: "completed" } },
    ]);
  },
);

serverTest(
  "restarting during a run interrupts it without disabling the routine",
  async ({ server }) => {
    await installExtension(server, "appointments");
    const routine = await server.rpc.routines.save({
      ...bookHaircut,
      action: { type: "runScript", command: "touch started; sleep 30" },
    });
    const first = await server.rpc.routines.runNow({ routineId: routine.id });
    await expect
      .poll(
        async () =>
          await fs
            .access(
              path.join(
                server.workspaceRoot,
                ".halo/extensions/appointments/started",
              ),
            )
            .then(
              () => true,
              () => false,
            ),
      )
      .toBe(true);
    expect(
      await server.rpc.routines.runNow({ routineId: routine.id }),
    ).toMatchObject({
      status: "skipped",
      error: "The previous run is still running.",
    });

    await server.stop();
    await server.start();

    const [overlap, interrupted] = await server.rpc.routines.listRuns({
      routineId: routine.id,
    });
    expect(overlap).toMatchObject({ status: "skipped" });
    expect(interrupted).toMatchObject({
      id: first.id,
      status: "interrupted",
      error: "Halo stopped before the run finished.",
    });
    const [restarted] = await server.rpc.routines.list();
    expect(restarted).toMatchObject({ enabled: true });
    expect(Date.parse(restarted!.nextRunAt!)).toBeGreaterThan(Date.now());
    const snapshot = await server.rpc.thread.snapshot({
      sessionId: interrupted!.sessionId!,
    });
    expect(sessionMessages(snapshot)).toMatchObject([
      {
        role: "bashExecution",
        command: "touch started; sleep 30",
        cancelled: true,
      },
    ]);
  },
);

serverTest(
  "automations share scheduled routines and persist trigger definitions",
  async ({ server }) => {
    const scheduled = await server.rpc.routines.save({
      ...bookHaircut,
      extensionId: undefined,
    });
    const webhook = await server.rpc.automations.save({
      name: "Handle incoming webhook",
      activation: { type: "trigger", trigger: { type: "webhook" } },
      action: { type: "runScript", command: "echo accepted" },
    });
    expect(webhook).toMatchObject({ revision: 1, enabled: true });
    expect(webhook.nextRunAt).toBeUndefined();
    expect(await server.rpc.automations.list()).toMatchObject([
      {
        id: scheduled.id,
        activation: {
          type: "routine",
          schedule: { cron: bookHaircut.cron, timezone: bookHaircut.timezone },
        },
      },
      {
        id: webhook.id,
        activation: { type: "trigger", trigger: { type: "webhook" } },
      },
    ]);
    expect(
      (await server.rpc.routines.list()).map((routine) => routine.id),
    ).toEqual([scheduled.id]);
    await expect(
      server.rpc.routines.setEnabled({ routineId: webhook.id, enabled: false }),
    ).rejects.toThrow();
    const gmail = await server.rpc.automations.save({
      id: webhook.id,
      name: "Handle mail",
      activation: {
        type: "trigger",
        trigger: {
          type: "gmail",
          connectionAddress: "gmail/personal",
          event: "messageReceived",
          from: "SENDER@example.com",
          subjectContains: "Invoice",
        },
      },
      action: { type: "runAgent", prompt: "Summarize the new invoice" },
    });
    expect(gmail).toMatchObject({
      revision: 2,
      activation: { trigger: { from: "sender@example.com" } },
    });
    await server.stop();
    await server.start();
    expect(
      (await server.rpc.automations.list()).find(
        (automation) => automation.id === gmail.id,
      ),
    ).toEqual(gmail);
    const paused = await server.rpc.automations.setEnabled({
      automationId: gmail.id,
      enabled: false,
    });
    expect(paused).toMatchObject({ revision: 3, enabled: false });
    await server.rpc.automations.remove({ automationId: scheduled.id });
    expect(await server.rpc.routines.list()).toEqual([]);
  },
);
