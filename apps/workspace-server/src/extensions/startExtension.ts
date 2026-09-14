import {
  spawn,
  type ChildProcess,
  type Serializable,
} from "node:child_process";
import { createInterface } from "node:readline";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Logger } from "@repo/logger";
import { workspaceCliPath } from "../workspace/installHaloCli.js";
import * as errore from "errore";

export type ExtensionRuntime = {
  executable: string;
  electronRunAsNode: boolean;
};

class ExtensionProcessError extends errore.createTaggedError({
  name: "ExtensionProcessError",
  message: "Extension '$id': $detail",
}) {}

const extensionUrlSchema = Type.String({
  pattern: "^http://127\\.0\\.0\\.1:[0-9]+/view/$",
});

export async function startExtension(args: {
  id: string;
  workspaceRoot: string;
  directory: string;
  dataDirectory: string;
  runtime: ExtensionRuntime;
  logger: Logger;
  tools: { origin: string; token: string };
}) {
  const child = errore.try({
    try: () =>
      spawn(
        args.runtime.executable,
        ["dist/start.mjs", "--port", "0", "--data-dir", args.dataDirectory],
        {
          cwd: args.directory,
          env: {
            ...process.env,
            PATH: workspaceCliPath(args.workspaceRoot),
            HALO_EXTENSION_TOOLS_ORIGIN: args.tools.origin,
            HALO_EXTENSION_TOOLS_TOKEN: args.tools.token,
            ELECTRON_RUN_AS_NODE: args.runtime.electronRunAsNode
              ? "1"
              : undefined,
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      ),
    catch: (cause) =>
      new ExtensionProcessError({
        id: args.id,
        detail: "could not spawn server",
        cause,
      }),
  });
  if (child instanceof Error) return child;
  let stopping = false;
  const exited = new Promise<undefined | ExtensionProcessError>((resolve) => {
    child.once("close", (code, signal) => {
      if (!stopping)
        args.logger.warn({
          event: "extension-exited",
          id: args.id,
          reason: signal === null ? String(code) : signal,
        });
      resolve(
        code === 0
          ? undefined
          : new ExtensionProcessError({
              id: args.id,
              detail: `server exited (${signal === null ? code : signal})`,
            }),
      );
    });
  });
  // Node's spawn overload for an extra IPC descriptor loses the explicit pipe types.
  const stdout = createInterface({ input: child.stdout! });
  const stderr = createInterface({ input: child.stderr! });
  stdout.on("line", (line: string) =>
    args.logger.info({ event: "extension-stdout", id: args.id, line }),
  );
  stderr.on("line", (line: string) =>
    args.logger.warn({ event: "extension-stderr", id: args.id, line }),
  );
  const url = await waitForReady({ child, id: args.id });
  if (url instanceof Error) {
    stopping = true;
    child.kill("SIGKILL");
    await exited;
    return url;
  }
  return {
    id: args.id,
    url,
    isRunning() {
      return child.exitCode === null && child.signalCode === null;
    },
    async stop() {
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null)
        return await exited;
      using cleanup = new errore.DisposableStack();
      // Extension code can keep Node alive after the SDK closes its server.
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      cleanup.defer(() => clearTimeout(timeout));
      // Node forcibly kills processes on Windows for SIGTERM; IPC lets the SDK flush storage.
      child.send("shutdown", (cause) => {
        if (cause === null) return;
        args.logger.warn({
          event: "extension-shutdown-message-failed",
          error: cause,
        });
        child.kill("SIGKILL");
      });
      return await exited;
    },
  };
}

async function waitForReady(args: { child: ChildProcess; id: string }) {
  using cleanup = new errore.DisposableStack();
  return await new Promise<string | ExtensionProcessError>((resolve) => {
    const onMessage = (message: Serializable) => {
      if (Value.Check(extensionUrlSchema, message)) resolve(message);
    };
    const onError = (cause: Error) =>
      resolve(
        new ExtensionProcessError({
          id: args.id,
          detail: "could not start server",
          cause,
        }),
      );
    const onClose = () =>
      resolve(
        new ExtensionProcessError({
          id: args.id,
          detail: "server exited before becoming ready",
        }),
      );
    // An extension may never reach its SDK startup code.
    const timeout = setTimeout(
      () =>
        resolve(
          new ExtensionProcessError({
            id: args.id,
            detail: "server did not become ready within 15 seconds",
          }),
        ),
      15_000,
    );
    args.child.on("message", onMessage);
    args.child.once("error", onError);
    args.child.once("close", onClose);
    cleanup.defer(() => {
      clearTimeout(timeout);
      args.child.off("message", onMessage);
      args.child.off("error", onError);
      args.child.off("close", onClose);
    });
  });
}
