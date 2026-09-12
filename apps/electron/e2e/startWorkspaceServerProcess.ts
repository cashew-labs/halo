import fs from "node:fs/promises";
import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { createInterface } from "node:readline";
import { Value } from "@sinclair/typebox/value";
import type { WorkspaceServerConfig } from "@get-halo/config/workspaceServer";
import {
  workspaceServerReadySchema,
  type WorkspaceServerReady,
} from "@get-halo/workspace-server/process";
import type { Logger } from "@repo/logger";
import type { OpenAILLMApiOptions } from "@get-halo/workspace-server/llm";
import * as errore from "errore";

class WorkspaceServerProcessError extends errore.createTaggedError({
  name: "WorkspaceServerProcessError",
  message: "User-server process failed: $detail",
}) {}

export async function startWorkspaceServerProcess(ctx: {
  entry: string;
  config: WorkspaceServerConfig;
  logger: Logger;
  configPath: string;
  llmConfiguration: OpenAILLMApiOptions;
}) {
  const written = await fs
    .writeFile(ctx.configPath, JSON.stringify(ctx.config), { mode: 0o600 })
    .catch(
      (cause) =>
        new WorkspaceServerProcessError({
          detail: "write configuration",
          cause,
        }),
    );
  if (written instanceof Error) return written;
  const child = errore.try({
    try: () =>
      fork(ctx.entry, [ctx.configPath], {
        execArgv: ["--import", "tsx"],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: undefined,
          HALO_E2E: "1",
          HALO_LLM_CONFIG: JSON.stringify(ctx.llmConfiguration),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }),
    catch: (cause) =>
      new WorkspaceServerProcessError({ detail: "spawn", cause }),
  });
  if (child instanceof Error) return child;
  const exited = new Promise<void | WorkspaceServerProcessError>((resolve) => {
    child.once("close", (code, signal) =>
      resolve(
        code === 0
          ? undefined
          : new WorkspaceServerProcessError({
              detail: `exited (${signal === null ? code : signal})`,
            }),
      ),
    );
  });
  // Node's fork overload does not narrow streams from the stdio configuration.
  const stdout = createInterface({ input: child.stdout! });
  const stderr = createInterface({ input: child.stderr! });
  stdout.on("line", (line: string) =>
    ctx.logger.info({ event: "workspace-server-stdout", line }),
  );
  stderr.on("line", (line: string) =>
    ctx.logger.warn({ event: "workspace-server-stderr", line }),
  );
  child.on("error", (error) =>
    ctx.logger.warn({ event: "workspace-server-process-error", error }),
  );
  const ready = await waitForReady(child);
  if (ready instanceof Error) {
    child.kill("SIGKILL");
    await exited;
    return ready;
  }
  return {
    ...ready,
    exited,
    isRunning: () => child.exitCode === null && child.signalCode === null,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null)
        return await exited;
      using cleanup = new errore.DisposableStack();
      // Extensions or shell tools may prevent graceful shutdown from completing.
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      cleanup.defer(() => clearTimeout(timeout));
      // Windows SIGTERM kills immediately; IPC allows sessions and databases to close.
      child.send("shutdown", (cause) => {
        if (cause === null) return;
        ctx.logger.warn({
          event: "workspace-server-shutdown-message-failed",
          error: cause,
        });
        child.kill("SIGKILL");
      });
      return await exited;
    },
  };
}

async function waitForReady(child: ChildProcess) {
  using cleanup = new errore.DisposableStack();
  return await new Promise<WorkspaceServerReady | WorkspaceServerProcessError>(
    (resolve) => {
      const onMessage = (message: Serializable) => {
        if (Value.Check(workspaceServerReadySchema, message)) resolve(message);
      };
      const onError = (cause: Error) =>
        resolve(new WorkspaceServerProcessError({ detail: "startup", cause }));
      const onClose = () =>
        resolve(
          new WorkspaceServerProcessError({
            detail: "exited before becoming ready",
          }),
        );
      // Startup installs integration catalogs and starts extension processes, which can stall.
      const timeout = setTimeout(
        () =>
          resolve(
            new WorkspaceServerProcessError({
              detail: "startup exceeded 60 seconds",
            }),
          ),
        60_000,
      );
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("close", onClose);
      cleanup.defer(() => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("close", onClose);
      });
    },
  );
}
