// coverage-exempt: Process entrypoint starts Cloud Run with live GCP credentials; protocol tests exercise ControlPlane.start.
import { workspaceRegistryToken } from "./workspace/workspaceRegistryToken.js";
import { GoogleAuth } from "google-auth-library";
import { TraceCloud } from "./traces/TraceCloud.js";
import path from "node:path";
import {
  readControlPlaneConfig,
  type ControlPlaneApplicationConfig,
} from "@get-halo/config/controlPlane";
import { Logger } from "@get-halo/logger";
import { PrettyConsoleLoggerSink } from "@get-halo/logger/PrettyConsoleLoggerSink";
import { CloudLoggingSink } from "./logging/CloudLoggingSink.js";
import * as errore from "errore";
import { ControlPlane } from "./server/ControlPlane.js";
import { GcpWorkspaceProvider } from "./workspace/provider/gcp/GcpWorkspaceProvider.js";
import { LocalWorkspaceProvider } from "./workspace/provider/local/LocalWorkspaceProvider.js";
import { ExeWorkspaceProvider } from "./workspace/provider/exe/ExeWorkspaceProvider.js";
// coverage-exempt: Process entry point is not imported by tests; its provider factory is covered through the public server.
import { createWorkspaceInference } from "./inference/createWorkspaceInference.js";

async function run(ctx: {
  config: ControlPlaneApplicationConfig;
  logger: Logger;
}) {
  const { config, logger } = ctx;
  const stopping = new Promise<void>((stop) => {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("disconnect", stop);
    process.on("message", (message) => {
      if (message === "shutdown") stop();
    });
  });
  const workspaceProvider =
    config.server.workspace.deployment === "exe"
      ? new ExeWorkspaceProvider(config.server.workspace)
      : config.server.deployment === "local"
        ? new LocalWorkspaceProvider({
            appDataDir: config.server.appDataDir,
            logger: logger.scope("local-workspace"),
          })
        : new GcpWorkspaceProvider(config.server.workspace);
  const plane = await ControlPlane.start({
    logger,
    build:
      process.env.HALO_BUILD_REVISION === undefined
        ? undefined
        : {
            version: process.env.HALO_BUILD_VERSION ?? "dev",
            revision: process.env.HALO_BUILD_REVISION,
          },
    config: config.server,
    // coverage-exempt: Bootstrap supplies live release metadata and GCP reader identity; config and registry adapter have focused tests.
    workspaceUpdateTarget:
      config.server.workspaceUpdates === undefined
        ? undefined
        : {
            image: config.server.workspaceUpdates.image,
            version: process.env.HALO_BUILD_VERSION ?? "dev",
          },
    workspaceUpdateToken:
      config.server.workspaceUpdates === undefined
        ? undefined
        : async () =>
            await workspaceRegistryToken(
              config.server.workspaceUpdates!.imagePuller,
            ),
    // coverage-exempt: Process bootstrap uses live credentials; the same provider factory is exercised through ControlPlane.start in the HTTP tests.
    inference: createWorkspaceInference({
      apiKey: config.inferenceApiKey,
      auth: new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      }),
    }),
    integrationEncryptionKey: config.integrationEncryptionKey,
    workspaceProvider,
    traceCloud:
      config.server.deployment === "cloudRun"
        ? new TraceCloud({
            bucket: config.server.traceBucket,
            auth: new GoogleAuth({
              scopes: ["https://www.googleapis.com/auth/cloud-platform"],
            }),
          })
        : undefined,
    webRoot: path.resolve(import.meta.dirname, "../../web-app/dist"),
  });
  if (plane instanceof Error) return plane;
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(async () => {
    const closed = await plane.close();
    if (closed instanceof Error)
      logger.error({
        event: "control-plane-close-failed",
        errorType: closed.name,
        reason: closed.message,
      });
  });
  logger.info({ event: "control-plane-listening", origin: plane.origin });
  if (process.connected) process.send?.({ origin: plane.origin });
  await stopping;
}

const config = await readControlPlaneConfig();
const root = new Logger({
  sinks: [
    config instanceof Error || config.server.deployment === "cloudRun"
      ? new CloudLoggingSink()
      : new PrettyConsoleLoggerSink(),
  ],
});
using lifetime = new errore.DisposableStack();
lifetime.defer(() => root.destroy());
const logger = root.scope("control-plane");
const result = config instanceof Error ? config : await run({ config, logger });
if (result instanceof Error)
  logger.error({
    event: "control-plane-failed",
    errorType: result.name,
    reason: result.message,
  });
// A parent's shutdown message leaves IPC connected; release it so output can drain and Node can exit.
if (process.connected) process.disconnect();
process.exitCode = result instanceof Error ? 1 : 0;
