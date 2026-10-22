import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as errore from "errore";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  DeviceAccess,
  type DeviceCommandRequest,
  type DevicePermissions,
} from "./DeviceAccess.js";
import { DeviceShell } from "./DeviceShell.js";

let home: string;

beforeEach(async () => {
  home = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "device-shell-")),
  );
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

/** A computer whose person answers the command prompt with `allow`. */
function device(input: { allow?: boolean; commandsAllowed?: boolean } = {}) {
  const saved: DevicePermissions[] = [];
  const askCommands = vi.fn(
    async (_request: DeviceCommandRequest) =>
      await Promise.resolve(input.allow ?? false),
  );
  const access = new DeviceAccess({
    permissions: {
      grants: [],
      commandsAllowed: input.commandsAllowed ?? false,
    },
    home,
    ask: async () => await Promise.resolve("deny" as const),
    askCommands,
    save: async (permissions) => {
      saved.push(permissions);
      await Promise.resolve();
    },
  });
  const shell = new DeviceShell({ access, home, shell: "/bin/sh" });
  const run = async (
    command: string,
    options: { timeoutMs?: number; signal?: AbortSignal; cwd?: string } = {},
  ) =>
    await shell.run(
      {
        type: "shell.run",
        command,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs ?? 10_000,
      },
      options.signal ?? new AbortController().signal,
    );
  return { run, askCommands, saved, access };
}

test("asks once, then runs commands in the home folder", async () => {
  const { run, askCommands, saved } = device({ allow: true });
  expect(await run("pwd; echo oops >&2; exit 3")).toEqual({
    code: 3,
    timedOut: false,
    stdout: `${home}\n`,
    stderr: "oops\n",
    truncated: false,
  });
  expect(await run("echo again")).toMatchObject({ code: 0, stdout: "again\n" });
  expect(askCommands).toHaveBeenCalledTimes(1);
  expect(askCommands.mock.calls[0]?.[0]).toMatchObject({
    command: "pwd; echo oops >&2; exit 3",
    cwd: home,
  });
  expect(saved).toEqual([{ grants: [], commandsAllowed: true }]);
});

test("a refusal runs nothing and is not asked again", async () => {
  const { run, askCommands } = device({ allow: false });
  const marker = path.join(home, "ran");
  expect(await run(`touch ${marker}`)).toMatchObject({ code: "access_denied" });
  expect(await run(`touch ${marker}`)).toMatchObject({ code: "access_denied" });
  expect(askCommands).toHaveBeenCalledTimes(1);
  await expect(fs.stat(marker)).rejects.toThrow();
});

test("runs in the requested folder", async () => {
  const { run } = device({ commandsAllowed: true });
  await fs.mkdir(path.join(home, "project"));
  expect(await run("pwd", { cwd: path.join(home, "project") })).toMatchObject({
    stdout: `${path.join(home, "project")}\n`,
  });
  expect(await run("pwd", { cwd: path.join(home, "missing") })).toMatchObject({
    code: "not_found",
  });
});

test("a timeout stops the command and the processes it started", async () => {
  const { run } = device({ commandsAllowed: true });
  const pidFile = path.join(home, "child.pid");
  const started = Date.now();
  const result = await run(`sleep 30 & echo $! > ${pidFile}; wait`, {
    timeoutMs: 300,
  });
  expect(result).toMatchObject({ timedOut: true, signal: "SIGTERM" });
  expect(Date.now() - started).toBeLessThan(5_000);
  const child = Number(await fs.readFile(pidFile, "utf8"));
  await expect.poll(() => isRunning(child)).toBe(false);
});

test("cancelling stops a running command", async () => {
  const { run } = device({ commandsAllowed: true });
  const cancel = new AbortController();
  const running = run("sleep 30", { signal: cancel.signal });
  setTimeout(() => cancel.abort(), 200);
  expect(await running).toMatchObject({ timedOut: false, signal: "SIGTERM" });
});

test("long output keeps its beginning and end", async () => {
  const { run } = device({ commandsAllowed: true });
  const result = await run(
    "echo START; head -c 100000 /dev/zero | tr '\\0' x; echo; echo END",
  );
  if (result instanceof Error) throw result;
  expect(result.truncated).toBe(true);
  expect(result.stdout.startsWith("START\n")).toBe(true);
  expect(result.stdout.endsWith("END\n")).toBe(true);
  expect(result.stdout).toMatch(/characters omitted/);
  expect(result.stdout.length).toBeLessThan(40_000);
});

function isRunning(pid: number) {
  // Signal 0 checks for the process without affecting it; it throws once the
  // process is gone.
  const checked = errore.try({
    try: () => process.kill(pid, 0),
    catch: (cause) => new Error("gone", { cause }),
  });
  return !(checked instanceof Error);
}
