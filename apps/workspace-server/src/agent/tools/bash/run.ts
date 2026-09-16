import { spawn } from "node:child_process";
import { workspaceExecutablePath } from "../../../workspace/installHaloCli.js";
import * as errore from "errore";

export class BashRunError extends errore.createTaggedError({
  name: "BashRunError",
  message: "Failed to run bash command",
}) {}

export class BashTimeoutError extends errore.createTaggedError({
  name: "BashTimeoutError",
  message: "Command timed out after $timeoutMs ms",
  extends: errore.AbortError,
}) {}

type BashProcessError = BashRunError | BashTimeoutError;

export async function runBash(
  cwd: string,
  {
    command,
    timeoutMs,
    signal,
  }: {
    command: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
) {
  if (signal?.aborted) {
    return new BashRunError({ cause: signal.reason });
  }

  const limitMs = timeoutMs === undefined ? 10_000 : timeoutMs;

  return await new Promise<
    { stdout: string; stderr: string; code: number | null } | BashProcessError
  >((resolve) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      env: {
        ...process.env,
        PATH: workspaceExecutablePath(cwd),
        PAGER: "cat",
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let terminationError: BashProcessError | undefined;

    const finish = (
      result:
        | { stdout: string; stderr: string; code: number | null }
        | BashProcessError,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminationError === undefined) clearTimeout(forceKill);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const killProcessGroup = (killSignal: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid === undefined) return;
      const killed = errore.try({
        try: () => process.kill(-pid, killSignal),
        catch: (e) => new BashRunError({ cause: e }),
      });
      // The process group can disappear between the close check and kill.
      if (killed instanceof Error && child.exitCode === null) {
        child.kill(killSignal);
      }
    };

    const terminate = (error: BashProcessError) => {
      if (terminationError !== undefined) return;
      terminationError = error;
      killProcessGroup("SIGTERM");
      forceKill = setTimeout(() => killProcessGroup("SIGKILL"), 250);
    };

    const onAbort = () => {
      terminate(new BashRunError({ cause: signal?.reason }));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    timeout = setTimeout(() => {
      terminate(new BashTimeoutError({ timeoutMs: limitMs }));
    }, limitMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      finish(new BashRunError({ cause: error }));
    });

    child.on("close", (code) => {
      if (terminationError !== undefined) {
        finish(terminationError);
        return;
      }
      finish({ stdout, stderr, code });
    });
  });
}
