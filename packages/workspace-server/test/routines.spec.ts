import fs from "node:fs/promises";
import path from "node:path";
import {
  createWorkspaceRemote,
  haloSchemaToTandemSchema,
  workspaceSchema,
  sessionMessages,
  type HaloClient,
  type RoutineInput,
  type RoutineRunStatus,
} from "@get-halo/client";
import { expect } from "vitest";
import * as errore from "errore";
import { TandemClient } from "@tanishqkancharla/tandem-core";
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
  "syncs routines and related runs through Tandem",
  async ({ server }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    await installExtension(server, "appointments");
    const routine = await server.rpc.routines.save(bookHaircut);
    const controller = new AbortController();
    const db = new TandemClient({
      ...haloSchemaToTandemSchema(workspaceSchema),
      remote: createWorkspaceRemote({
        api: server.rendererRpc,
        signal: controller.signal,
        onDisconnect: console.warn,
      }),
      autoConnect: false,
    });
    cleanup.defer(async () => await db.disconnect());
    cleanup.defer(() => controller.abort());
    const query = {
      collection: "routines",
      orderBy: { createdAt: "asc", id: "asc" },
      with: { lastRun: true },
    } as const;
    const subscription = db.subscribe(query, () => {});
    cleanup.defer(subscription.destroy);
    await db.ready;
    await db.connect();
    await expect
      .poll(() => db.query(query))
      .toMatchObject([{ id: routine.id, name: "Book haircut" }]);
    const runsQuery = {
      collection: "routineRuns",
      where: { routineId: routine.id },
      orderBy: { startedAt: "desc", sequence: "desc" },
      limit: 50,
    } as const;
    const runs = db.subscribe(runsQuery, () => {});
    cleanup.defer(runs.destroy);
    const run = await server.rpc.routines.runNow({ routineId: routine.id });
    await expect
      .poll(() => db.query(runsQuery))
      .toMatchObject([{ id: run.id, status: "completed" }]);
    await expect
      .poll(() => db.query(query))
      .toMatchObject([
        { id: routine.id, lastRun: { id: run.id, status: "completed" } },
      ]);
    const unrelated = await server.rpc.routines.save({
      ...bookHaircut,
      name: "Unrelated routine",
    });
    await server.rpc.routines.runNow({ routineId: unrelated.id });
    const latest = await server.rpc.routines.runNow({ routineId: routine.id });
    await expect
      .poll(() => db.query(runsQuery))
      .toMatchObject([
        { id: latest.id, status: "completed" },
        { id: run.id, status: "completed" },
      ]);
    await server.rpc.routines.remove({ routineId: routine.id });
    await expect
      .poll(() => db.query(query))
      .toMatchObject([{ id: unrelated.id }]);
    await expect.poll(() => db.query(runsQuery)).toEqual([]);
  },
);
