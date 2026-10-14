import http from "node:http";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";

export type AppSandboxConfig = { socketPath: string };

export class AppSandboxError extends errore.createTaggedError({
  name: "AppSandboxError",
  message: "App sandbox failed: $operation",
}) {}

const startedSchema = Type.Object({
  url: Type.String({ pattern: "^http://127\\.0\\.0\\.1:[0-9]+/view/$" }),
});
const statusSchema = Type.Object({ running: Type.Boolean() });
const stoppedSchema = Type.Object({ stopped: Type.Literal(true) });
const resetSchema = Type.Object({ reset: Type.Literal(true) });
const snapshotSchema = Type.Object(
  { data: Type.Optional(Type.String()) },
  { additionalProperties: false },
);
const executionSchema = Type.Object({
  output: Type.String(),
  exitCode: Type.Integer(),
});

/** The host controls all runtime, mount, network and resource-limit options. */
export class AppSandbox {
  private readonly socketPath: string;

  constructor(ctx: AppSandboxConfig) {
    this.socketPath = ctx.socketPath;
  }

  async start(ctx: {
    extensionId: string;
    // A template demo runs one instance per visitor.
    instance?: string;
    brokerPort: number;
    toolToken: string;
    hostToken: string;
    syncAccess: "read-only" | "shared" | "actions";
  }) {
    const started = await this.request("start", ctx);
    if (started instanceof Error) return started;
    if (!Value.Check(startedSchema, started))
      return new AppSandboxError({ operation: "invalid startup response" });
    const state = { running: true, checking: false, stopped: false };
    const monitor = setInterval(async () => {
      if (state.checking || !state.running) return;
      state.checking = true;
      const status = await this.request("status", {
        extensionId: ctx.extensionId,
        instance: ctx.instance,
      });
      if (state.stopped) return;
      state.checking = false;
      if (status instanceof Error || !Value.Check(statusSchema, status)) {
        console.warn(status);
        state.running = false;
        clearInterval(monitor);
        return;
      }
      state.running = status.running;
      if (!state.running) clearInterval(monitor);
    }, 2_000);
    monitor.unref();
    return {
      id: ctx.extensionId,
      url: started.url,
      hostToken: ctx.hostToken,
      isRunning: () => state.running,
      stop: async () => {
        state.stopped = true;
        clearInterval(monitor);
        state.running = false;
        const stopped = await this.request("stop", {
          extensionId: ctx.extensionId,
          instance: ctx.instance,
        });
        if (stopped instanceof Error) return stopped;
        if (!Value.Check(stoppedSchema, stopped))
          return new AppSandboxError({
            operation: "invalid shutdown response",
          });
      },
    };
  }

  /** Stops every demo instance of an extension and discards their data. */
  async resetInstances(extensionId: string) {
    const reset = await this.request("reset", { extensionId });
    if (reset instanceof Error) return reset;
    if (!Value.Check(resetSchema, reset))
      return new AppSandboxError({ operation: "invalid reset response" });
  }

  async snapshot(extensionId: string) {
    const captured = await this.request("snapshot", { extensionId });
    if (captured instanceof Error) return captured;
    if (!Value.Check(snapshotSchema, captured))
      return new AppSandboxError({ operation: "invalid snapshot response" });
    return captured.data;
  }

  async execute(ctx: { extensionId: string; command: string }) {
    const executed = await this.request("exec", ctx);
    if (executed instanceof Error) return executed;
    if (!Value.Check(executionSchema, executed))
      return new AppSandboxError({ operation: "invalid execution response" });
    return executed;
  }

  private async request(
    operation: "start" | "stop" | "status" | "exec" | "snapshot" | "reset",
    input: { extensionId: string; instance?: string },
  ): Promise<object | AppSandboxError> {
    return await new Promise((resolve) => {
      const body = JSON.stringify(input);
      const limit =
        operation === "snapshot"
          ? 32 * 1024 * 1024
          : operation === "exec"
            ? 65_536
            : 16_384;
      // Destroying a request can emit errors on both streams; settle once.
      const state = { settled: false };
      const settle = (result: Parameters<typeof resolve>[0]) => {
        if (state.settled) return;
        state.settled = true;
        resolve(result);
      };
      const request = http.request(
        {
          socketPath: this.socketPath,
          path: `/${operation}`,
          method: "POST",
          timeout: operation === "exec" ? 150_000 : 40_000,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          const received = { bytes: 0 };
          response.on("data", (chunk: Buffer) => {
            if (state.settled) return;
            received.bytes += chunk.length;
            if (received.bytes > limit) {
              settle(
                new AppSandboxError({
                  operation: `${operation} response too large`,
                }),
              );
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", (cause) =>
            settle(new AppSandboxError({ operation, cause })),
          );
          response.once("end", () => {
            const parsed = errore.try({
              // SAFETY: only JSON objects cross this supervisor boundary.
              try: () => JSON.parse(Buffer.concat(chunks).toString()) as object,
              catch: (cause) => new AppSandboxError({ operation, cause }),
            });
            if (parsed instanceof Error) return settle(parsed);
            if (response.statusCode !== 200)
              return settle(new AppSandboxError({ operation, cause: parsed }));
            settle(parsed);
          });
        },
      );
      request.once("timeout", () => {
        settle(new AppSandboxError({ operation: `${operation} timed out` }));
        request.destroy();
      });
      request.on("error", (cause) =>
        settle(new AppSandboxError({ operation, cause })),
      );
      request.end(body);
    });
  }
}
