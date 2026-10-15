import childProcess from "node:child_process";
import crypto from "node:crypto";
import timers from "node:timers/promises";
import type { UserActionableError } from "@executor-js/sdk/core";
import { workspaceExecutablePath } from "../../../workspace/installHaloCli.js";
import * as errore from "errore";
import { BashOutput, type BashOutputResult } from "./BashOutput.js";

export class BashRunError extends errore.createTaggedError({
  name: "BashRunError",
  message: "Failed to run bash command",
}) {}

export class BashTimeoutError
  extends errore.createTaggedError({
    name: "BashTimeoutError",
    message: "Command timed out after $timeoutMs ms",
    extends: errore.AbortError,
  })
  implements UserActionableError
{
  readonly __executorUserActionable = true as const;
  readonly code = "timeout";
  get userMessage() {
    return this.message;
  }
}

export class BashTimeoutLimitError
  extends errore.createTaggedError({
    name: "BashTimeoutLimitError",
    message: "Timeout $timeoutMs ms is longer than 15 minutes",
  })
  implements UserActionableError
{
  readonly __executorUserActionable = true as const;
  readonly code = "timeout_limit";
  get userMessage() {
    return this.message;
  }
}

export const maxBashToolTimeoutMs = 10 * 60 * 1_000;
export const maxBashTimeoutMs = 15 * 60 * 1_000;

type BashProcessError = BashRunError | BashTimeoutError;

// Keep the process-group owner alive until its output pipes close or cancellation
// escalates. Otherwise the shell can exit before an untagged background child,
// and its PID can later name an unrelated process group. The command runs in its
// own bash with no stdin; the supervisor's stdin is only a lifetime pipe.
const bashSupervisor = `
trap ':' TERM
bash -c "$1" </dev/null
status=$?
exec 1>&- 2>&-
while :; do
  read -r _
  read_status=$?
  if [ "$read_status" -le 128 ]; then break; fi
done
exit "$status"
`;

export async function runBash(
  workspaceRoot: string,
  {
    command,
    env,
    cwd,
    timeoutMs,
    signal,
    output,
  }: {
    command: string;
    env?: Record<string, string | undefined>;
    // Defaults to the workspace root.
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    output: { directory: string; headChars: number; tailChars: number };
  },
) {
  if (signal?.aborted) {
    return new BashRunError({ cause: signal.reason });
  }

  const limitMs = timeoutMs === undefined ? 10_000 : timeoutMs;
  if (limitMs > maxBashTimeoutMs) {
    return new BashTimeoutLimitError({ timeoutMs: limitMs });
  }

  let child: ReturnType<typeof childProcess.spawn> | undefined;
  let outputFailure: Error | undefined;
  let terminateForOutput: (() => void) | undefined;
  const capture = await BashOutput.create({
    ...output,
    onDrain: () => {
      child?.stdout?.resume();
      child?.stderr?.resume();
    },
    onError: (error) => {
      outputFailure = error;
      terminateForOutput?.();
    },
  });
  if (capture instanceof Error) return new BashRunError({ cause: capture });
  if (signal?.aborted) {
    await capture.finish();
    await capture.discard();
    return new BashRunError({ cause: signal.reason });
  }

  return await new Promise<
    (BashOutputResult & { code: number | null }) | BashProcessError
  >((resolve) => {
    // Descendants inherit this identity even after setsid or shell exit.
    const runId = crypto.randomUUID();
    const running = childProcess.spawn(
      "bash",
      ["-c", bashSupervisor, "halo-bash", command],
      {
        cwd: cwd ?? workspaceRoot,
        env: {
          ...process.env,
          ...env,
          PATH: workspaceExecutablePath(workspaceRoot),
          PAGER: "cat",
          HALO_BASH_RUN_ID: runId,
        },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child = running;

    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let termination: Promise<void> | undefined;
    let terminationError: BashProcessError | undefined;

    const finish = (
      result: (BashOutputResult & { code: number | null }) | BashProcessError,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const terminate = (error: BashProcessError) => {
      if (terminationError !== undefined) return;
      terminationError = error;
      termination = (async () => {
        await signalBashProcesses({
          runId,
          pid:
            running.exitCode === null && running.signalCode === null
              ? running.pid
              : undefined,
          signal: "SIGTERM",
        });
        await timers.setTimeout(250);
        await signalBashProcesses({
          runId,
          pid:
            running.exitCode === null && running.signalCode === null
              ? running.pid
              : undefined,
          signal: "SIGKILL",
        });
        // An escaped child can retain a pipe even after the shell exits. Stop
        // must finish even if that child cleared its inherited run identity.
        running.stdin.destroy();
        running.stdout.destroy();
        running.stderr.destroy();
      })();
    };
    terminateForOutput = () =>
      terminate(new BashRunError({ cause: outputFailure }));
    if (outputFailure !== undefined) terminateForOutput();

    const onAbort = () => {
      terminate(new BashRunError({ cause: signal?.reason }));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    timeout = setTimeout(() => {
      terminate(new BashTimeoutError({ timeoutMs: limitMs }));
    }, limitMs);

    const releaseSupervisor = () => {
      if (
        terminationError === undefined &&
        running.stdout.readableEnded &&
        running.stderr.readableEnded
      )
        running.stdin.end();
    };
    running.stdout.on("end", releaseSupervisor);
    running.stderr.on("end", releaseSupervisor);
    running.stdin.on("error", (cause) =>
      terminate(new BashRunError({ cause })),
    );

    const append = (source: "stdout" | "stderr", chunk: Buffer) => {
      const written = capture.append(source, chunk);
      if (written instanceof Error) {
        terminate(new BashRunError({ cause: written }));
        return;
      }
      if (written) return;
      running.stdout.pause();
      running.stderr.pause();
    };
    running.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    running.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

    running.on("error", (error) => {
      terminationError = new BashRunError({ cause: error });
    });

    running.on("close", async (code) => {
      // Do not cancel escalation when the shell exits before its descendants.
      await termination;
      const captured = await capture.finish();
      if (terminationError !== undefined) {
        await capture.discard();
        finish(terminationError);
        return;
      }
      if (captured instanceof Error) {
        await capture.discard();
        finish(new BashRunError({ cause: captured }));
        return;
      }
      finish({ ...captured, code });
    });
  });
}

async function signalBashProcesses(input: {
  runId: string;
  pid: number | undefined;
  signal: NodeJS.Signals;
}) {
  const processes = await new Promise<string | BashRunError>((resolve) => {
    // e includes inherited environment; ww avoids truncating the run identity.
    // Keep this output private: it contains other processes' environments.
    childProcess.execFile(
      "ps",
      ["eww", "-ax", "-o", "pid=,pgid=,command="],
      {
        timeout: 1_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (cause, stdout) =>
        resolve(cause === null ? stdout : new BashRunError({ cause })),
    );
  });
  const pids = new Set<number>();
  if (processes instanceof Error) {
    console.warn(
      "Could not find detached bash descendants:",
      processes.message,
    );
  } else {
    const marker = `HALO_BASH_RUN_ID=${input.runId}`;
    for (const line of processes.split("\n")) {
      const fields = line.trim().split(/\s+/u);
      // Same-group children can clear their environment before the shell exits.
      if (fields.includes(marker) || Number(fields[1]) === input.pid)
        pids.add(Number(fields[0]));
    }
  }
  if (input.pid !== undefined) pids.add(input.pid);
  // Signal groups as well as individual PIDs, including detached sessions.
  for (const pid of pids) {
    for (const target of [-pid, pid]) {
      const killed = errore.try({
        try: () => process.kill(target, input.signal),
        catch: (cause) => new BashRunError({ cause }),
      });
      if (killed instanceof Error) {
        const cause = killed.cause;
        // A process can exit between the snapshot and either signal.
        if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
          continue;
        console.warn("Could not stop bash process:", target, killed.message);
      }
    }
  }
}
