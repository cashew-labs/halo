import childProcess from "node:child_process";
import * as errore from "errore";
import fs from "node:fs/promises";
import path from "node:path";
import {
  deviceShellLimits,
  type DeviceOperation,
  type DeviceShellResult,
  type DeviceRequestContext,
} from "@get-halo/client";
import { fileError, ioError, type DeviceAccess } from "./DeviceAccess.js";

type ShellOperation = Extract<DeviceOperation, { type: "shell.run" }>;

// Gives a stopped command time to exit before it is killed.
const killGraceMs = 1_000;

/**
 * Runs the agent's commands in the person's login shell, so PATH and other
 * settings match their terminal. Each command gets its own process group so
 * a timeout or cancellation also stops the processes it started.
 */
export class DeviceShell {
  private readonly access: DeviceAccess;
  private readonly home: string;
  private readonly shell: string;

  constructor(ctx: { access: DeviceAccess; home: string; shell?: string }) {
    this.access = ctx.access;
    this.home = ctx.home;
    this.shell = ctx.shell ?? process.env.SHELL ?? "/bin/sh";
  }

  async run(
    operation: ShellOperation,
    signal: AbortSignal,
    context?: DeviceRequestContext,
  ) {
    const cwd = operation.cwd ?? this.home;
    if (!path.isAbsolute(cwd))
      return fileError(
        "not_a_directory",
        `Expected an absolute working folder, received ${cwd}`,
      );
    const allowed = await this.access.authorizeCommand({
      command: operation.command,
      cwd,
      signal,
      context,
    });
    if (allowed instanceof Error) return allowed;
    if (signal.aborted)
      return fileError("access_denied", "The command was cancelled");
    const folder = await fs.stat(cwd).catch((cause) => ioError(cwd, cause));
    if (folder instanceof Error) return folder;
    if (!folder.isDirectory())
      return fileError("not_a_directory", `${cwd} is not a folder`);
    const timeoutMs = Math.min(
      operation.timeoutMs,
      deviceShellLimits.maxTimeoutMs,
    );
    return await this.spawn({
      command: operation.command,
      cwd,
      timeoutMs,
      signal,
    });
  }

  private async spawn(input: {
    command: string;
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
  }) {
    return await new Promise<DeviceShellResult | ReturnType<typeof fileError>>(
      (resolve) => {
        const child = childProcess.spawn(this.shell, ["-lc", input.command], {
          cwd: input.cwd,
          env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat" },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout = new CappedOutput();
        const stderr = new CappedOutput();
        child.stdout
          .setEncoding("utf8")
          .on("data", (chunk: string) => stdout.add(chunk));
        child.stderr
          .setEncoding("utf8")
          .on("data", (chunk: string) => stderr.add(chunk));
        let timedOut = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = () => {
          signalGroup(child.pid, "SIGTERM");
          killTimer ??= setTimeout(() => {
            signalGroup(child.pid, "SIGKILL");
            // A process that left the group can hold the pipes open.
            child.stdout.destroy();
            child.stderr.destroy();
          }, killGraceMs);
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, input.timeoutMs);
        input.signal.addEventListener("abort", stop, { once: true });
        const finish = () => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          input.signal.removeEventListener("abort", stop);
        };
        child.once("error", (cause) => {
          finish();
          resolve(
            fileError(
              "io_error",
              `Could not start ${this.shell}: ${cause.message}`,
              cause,
            ),
          );
        });
        child.once("close", (code, exitSignal) => {
          finish();
          const out = stdout.text();
          const err = stderr.text();
          const result: DeviceShellResult = {
            timedOut,
            stdout: out.text,
            stderr: err.text,
            truncated: out.truncated || err.truncated,
          };
          if (code !== null) result.code = code;
          if (exitSignal !== null) result.signal = exitSignal;
          resolve(result);
        });
      },
    );
  }
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (pid === undefined) return;
  // A negative PID signals the whole process group. It fails only when the
  // group already exited, which needs no handling.
  errore.try({
    try: () => process.kill(-pid, signal),
    catch: (cause) => cause,
  });
}

/** Keeps the beginning and end of a long stream. */
class CappedOutput {
  private head = "";
  private tail = "";
  private total = 0;

  add(chunk: string) {
    this.total += chunk.length;
    const headRoom = deviceShellLimits.headChars - this.head.length;
    if (headRoom > 0) {
      this.head += chunk.slice(0, headRoom);
      chunk = chunk.slice(headRoom);
    }
    if (chunk.length === 0) return;
    this.tail = (this.tail + chunk).slice(-deviceShellLimits.tailChars);
  }

  text() {
    const kept = this.head.length + this.tail.length;
    if (kept >= this.total)
      return { text: this.head + this.tail, truncated: false };
    return {
      text: `${this.head}\n\n[${(this.total - kept).toLocaleString()} characters omitted]\n\n${this.tail}`,
      truncated: true,
    };
  }
}
