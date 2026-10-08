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
  "pausing cancels queued runs and restart interrupts the active run",
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
      status: "queued",
    });

    await server.rpc.routines.setEnabled({
      routineId: routine.id,
      enabled: false,
    });
    await server.stop();
    await server.start();

    const [overlap, interrupted] = await server.rpc.routines.listRuns({
      routineId: routine.id,
    });
    expect(overlap).toMatchObject({ status: "cancelled" });
    expect(interrupted).toMatchObject({
      id: first.id,
      status: "interrupted",
      error: "Halo stopped before the run finished.",
    });
    const [restarted] = await server.rpc.routines.list();
    expect(restarted).toMatchObject({ enabled: false });
    expect(restarted!.nextRunAt).toBeUndefined();
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

serverTest(
  "event retries are deduplicated and queued payloads survive restart without shell interpolation",
  async ({ server }) => {
    const automation = await server.rpc.automations.save({
      name: "Record events",
      activation: { type: "trigger", trigger: { type: "webhook" } },
      action: {
        type: "runScript",
        command: `touch event-started; while [ ! -f release-events ]; do sleep 0.02; done; node -e 'const fs = require("fs"); const event = JSON.parse(fs.readFileSync(process.env.HALO_AUTOMATION_EVENT_FILE, "utf8")); fs.appendFileSync("received-events", JSON.stringify(event.payload) + "\\n")'`,
      },
    });
    const first = {
      automationId: automation.id,
      revision: automation.revision,
      eventId: "event-first",
      source: "webhook" as const,
      occurredAt: new Date().toISOString(),
      payload: { value: "first" },
    };
    const accepted = await server.rpc.automations.acceptEvent(first);
    await expect
      .poll(
        async () =>
          (
            await server.rpc.automations.listRuns({
              automationId: automation.id,
            })
          )[0]?.status,
      )
      .toBe("running");
    expect((await server.rpc.automations.acceptEvent(first)).id).toBe(
      accepted.id,
    );
    await expect(
      server.rpc.automations.acceptEvent({
        ...first,
        payload: { value: "changed" },
      }),
    ).rejects.toThrow();
    const second = {
      ...first,
      eventId: "event-second",
      payload: {
        value: "$(touch injected); `touch injected`; 'quoted'\nnext line",
      },
    };
    const queued = await server.rpc.automations.acceptEvent(second);
    expect(queued.status).toBe("queued");
    await server.stop();
    await fs.writeFile(path.join(server.workspaceRoot, "release-events"), "");
    await server.start();
    await expect
      .poll(
        async () =>
          (
            await server.rpc.automations.listRuns({
              automationId: automation.id,
            })
          ).find((run) => run.id === queued.id)?.status,
      )
      .toBe("completed");
    const runs = await server.rpc.automations.listRuns({
      automationId: automation.id,
    });
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.id === accepted.id)?.status).toBe(
      "interrupted",
    );
    expect(
      await fs.readFile(
        path.join(server.workspaceRoot, "received-events"),
        "utf8",
      ),
    ).toBe(JSON.stringify(second.payload) + "\n");
    await expect(
      fs.stat(path.join(server.workspaceRoot, "injected")),
    ).rejects.toThrow();
    expect((await server.rpc.automations.acceptEvent(second)).id).toBe(
      queued.id,
    );
    await server.rpc.automations.setEnabled({
      automationId: automation.id,
      enabled: false,
    });
    await expect(
      server.rpc.automations.acceptEvent({ ...second, eventId: "event-third" }),
    ).rejects.toThrow();
  },
);

serverTest(
  "agents manage and run automations through the shared tool namespace",
  async ({ server }) => {
    await server.rpc.testApi.invokeTool({
      path: "automations.save",
      input: {
        name: "Tool-created automation",
        activation: { type: "trigger", trigger: { type: "webhook" } },
        action: {
          type: "runScript",
          command: 'cat "$HALO_AUTOMATION_EVENT_FILE" > tool-event.json',
        },
      },
    });
    const [automation] = await server.rpc.automations.list();
    expect(automation?.name).toBe("Tool-created automation");
    await server.rpc.testApi.invokeTool({
      path: "automations.pause",
      input: { automationId: automation!.id },
    });
    expect(
      await server.rpc.testApi.invokeTool({
        path: "automations.list",
        input: {},
      }),
    ).toMatchObject([{ id: automation!.id, enabled: false }]);
    await server.rpc.testApi.invokeTool({
      path: "automations.run",
      input: {
        automationId: automation!.id,
        samplePayload: { test: "paused" },
      },
    });
    await expect
      .poll(
        async () =>
          (
            await server.rpc.automations.listRuns({
              automationId: automation!.id,
            })
          )[0]?.status,
      )
      .toBe("completed");
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(server.workspaceRoot, "tool-event.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ payload: { test: "paused" } });
    expect(
      await server.rpc.testApi.invokeTool({
        path: "automations.history",
        input: { automationId: automation!.id },
      }),
    ).toMatchObject([
      { trigger: "manual", status: "completed", sessionId: expect.any(String) },
    ]);
  },
);
