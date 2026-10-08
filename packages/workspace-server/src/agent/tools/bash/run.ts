import { spawn } from "node:child_process";
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

  let child: ReturnType<typeof spawn> | undefined;
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
    const running = spawn("bash", ["-c", command], {
      cwd: cwd ?? workspaceRoot,
      env: {
        ...process.env,
        ...env,
        PATH: workspaceExecutablePath(workspaceRoot),
        PAGER: "cat",
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = running;

    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let terminationError: BashProcessError | undefined;

    const finish = (
      result: (BashOutputResult & { code: number | null }) | BashProcessError,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const killProcessGroup = (killSignal: NodeJS.Signals) => {
      const pid = running.pid;
      if (pid === undefined) return;
      const killed = errore.try({
        try: () => process.kill(-pid, killSignal),
        catch: (e) => new BashRunError({ cause: e }),
      });
      // The process group can disappear between the close check and kill.
      if (killed instanceof Error && running.exitCode === null) {
        running.kill(killSignal);
      }
    };

    const terminate = (error: BashProcessError) => {
      if (terminationError !== undefined) return;
      terminationError = error;
      killProcessGroup("SIGTERM");
      forceKill = setTimeout(() => killProcessGroup("SIGKILL"), 250);
    };
    terminateForOutput = () =>
      terminate(new BashRunError({ cause: outputFailure }));
    if (outputFailure !== undefined) terminateForOutput();

    const onAbort = () => {
      terminate(new BashRunError({ cause: signal?.reason }));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    timeout = setTimeout(() => {
      terminate(new BashTimeoutError({ timeoutMs: limitMs }));
    }, limitMs);

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
