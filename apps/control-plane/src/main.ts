import fs from "node:fs/promises";
import path from "node:path";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { config, type ControlPlaneConfig } from "@get-halo/config/controlPlane";
import { Logger } from "@get-halo/logger";
import { JsonlLoggerSink } from "@get-halo/logger/JsonlLoggerSink";
import { PrettyConsoleLoggerSink } from "@get-halo/logger/PrettyConsoleLoggerSink";
import * as errore from "errore";
import { ControlPlane } from "./server/ControlPlane.js";
import { TraceCloud } from "./traces/TraceCloud.js";

class ControlPlaneStartupError extends errore.createTaggedError({
  name: "ControlPlaneStartupError",
  message: "Control plane startup failed: $detail",
}) {}

async function run() {
  const stopping = new Promise<void>((stop) => {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("disconnect", stop);
    process.on("message", (message) => {
      if (message === "shutdown") stop();
    });
  });
  if (config instanceof Error) return config;
  const logger = await createControlPlaneLogger(config.server);
  if (logger instanceof Error) return logger;
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(async () => {
    await logger.flush();
    logger.destroy();
  });
  const plane = await ControlPlane.start({
    config: config.server,
    logger,
    traceCloud:
      config.server.deployment === "local"
        ? undefined
        : new TraceCloud({
            bucket: config.server.traceBucket,
            projectId: config.server.workspace.projectId,
            zone: config.server.workspace.zone,
            serviceAccount: config.server.workspaceServiceAccount,
            auth: new GoogleAuth({
              scopes: ["https://www.googleapis.com/auth/cloud-platform"],
            }),
            verifier: new OAuth2Client(),
            storageOrigin: "https://storage.googleapis.com",
            computeOrigin: "https://compute.googleapis.com",
          }),
    webRoot: path.resolve(import.meta.dirname, "../../web-app/dist"),
  });
  if (plane instanceof Error) {
    logger.error({ event: "start-failed", error: plane });
    return plane;
  }
  cleanup.defer(async () => {
    const closed = await plane.close();
    if (closed instanceof Error) {
      logger.error({ event: "close-failed", error: closed });
    }
  });
  logger.info({ event: "listening", origin: plane.origin });
  console.log(`Control plane listening at ${plane.origin}`);
  if (process.connected) process.send?.({ origin: plane.origin });
  await stopping;
}

async function createControlPlaneLogger(server: ControlPlaneConfig) {
  if (server.deployment !== "local") {
    return new Logger({
      sinks: [new PrettyConsoleLoggerSink()],
    }).scope("control-plane");
  }

  const logsDir = path.join(server.appDataDir, "logs");
  const created = await fs.mkdir(logsDir, { recursive: true }).catch(
    (cause) =>
      new ControlPlaneStartupError({
        detail: "create log directory",
        cause,
      }),
  );
  if (created instanceof Error) return created;

  return new Logger({
    sinks: [
      new PrettyConsoleLoggerSink(),
      new JsonlLoggerSink({
        filePath: path.join(
          logsDir,
          `${new Date().toISOString().slice(0, 10)}.jsonl`,
        ),
      }),
    ],
  }).scope("control-plane");
}

// oxlint-disable-next-line typescript/no-floating-promises -- This entry point owns the process lifetime and exits after service cleanup.
run().then((result) => {
  if (result instanceof Error) console.error(result);
  process.exit(result instanceof Error ? 1 : 0);
});
