import fs from "node:fs/promises";
import { dirname } from "node:path";
import { readWorkspaceServerApplicationConfig } from "@get-halo/config/workspaceServer";
import { ApplicationMode } from "@get-halo/config/ApplicationMode";
import { Logger } from "@get-halo/logger";
import { JsonlLoggerSink } from "@get-halo/logger/JsonlLoggerSink";
import {
  writeWorkspaceServerConnection,
  removeWorkspaceServerConnection,
} from "@get-halo/shared/WorkspaceServerConnection";
import {
  writeHaloRpcFile,
  removeHaloRpcFile,
} from "@get-halo/shared/HaloRpcFile";
import {
  ControlPlaneTraceUploader,
  ControlPlaneWorkReporter,
  ControlPlaneRoutineReporter,
  WorkspaceServer,
} from "@get-halo/workspace-server";
import { createOpenAILLMApi } from "@get-halo/workspace-server/llm";
import * as errore from "errore";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  controlPlaneProtocolVersion,
  type ControlPlaneClient,
} from "@get-halo/shared/controlPlaneContract";

class WorkspaceServerStartupError extends errore.createTaggedError({
  name: "WorkspaceServerStartupError",
  message: "Workspace server startup failed: $detail",
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
  const applicationConfig = await readWorkspaceServerApplicationConfig();
  if (applicationConfig instanceof Error) return applicationConfig;
  const created = await fs
    .mkdir(dirname(applicationConfig.server.logFilePath), { recursive: true })
    .catch(
      (cause) =>
        new WorkspaceServerStartupError({
          detail: "create log directory",
          cause,
        }),
    );
  if (created instanceof Error) return created;
  const llmApi = createOpenAILLMApi(applicationConfig.inference.options);
  const logger = new Logger({
    sinks: [
      new JsonlLoggerSink({ filePath: applicationConfig.server.logFilePath }),
    ],
  });
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(() => logger.destroy());
  const extensionRuntime =
    applicationConfig.server.extensionRuntime === undefined
      ? { executable: process.execPath, electronRunAsNode: false }
      : applicationConfig.server.extensionRuntime;
  const runtime = applicationConfig.server.runtime;
  const runtimeClient =
    runtime === undefined
      ? undefined
      : createORPCClient<ControlPlaneClient>(
          new RPCLink({
            origin: runtime.origin,
            url: "/rpc",
            headers: {
              authorization: `Bearer ${runtime.token}`,
              "x-halo-protocol-version": String(controlPlaneProtocolVersion),
            },
          }),
        );
  const remoteFailure = (cause: unknown) =>
    new WorkspaceServerStartupError({
      detail: "control-plane integration RPC",
      cause,
    });
  const server = await WorkspaceServer.start({
    config: {
      build:
        process.env.HALO_BUILD_REVISION === undefined
          ? undefined
          : {
              version: process.env.HALO_BUILD_VERSION ?? "dev",
              revision: process.env.HALO_BUILD_REVISION,
            },
      environment: applicationConfig.server.environment,
      workspaceRoot: applicationConfig.server.workspaceRoot,
      legacyExecutorTenant: applicationConfig.server.legacyExecutorTenant,
      appDataDir: applicationConfig.server.appDataDir,
      appVersion: applicationConfig.server.appVersion,
      ownerUserId: applicationConfig.server.ownerUserId,
      host:
        applicationConfig.mode === ApplicationMode.Production
          ? "0.0.0.0"
          : "127.0.0.1",
      port: applicationConfig.server.port,
      corsOrigins: applicationConfig.server.corsOrigins,
      testApiEnabled: applicationConfig.mode === ApplicationMode.Test,
      traceWorkspaceId: applicationConfig.server.runtime?.workspaceId,
      gateway: applicationConfig.server.gateway,
      desktopOrigin: process.env.HALO_DESKTOP_ORIGIN,
      cliEntry: applicationConfig.server.cliEntry,
      cliNodeExecutable: applicationConfig.server.cliNodeExecutable,
      cliElectronRunAsNode: applicationConfig.server.cliElectronRunAsNode,
      extensionRuntime,
    },
    host: {
      remoteIntegrationTools:
        applicationConfig.server.runtime === undefined
          ? undefined
          : {
              search: async (input, signal) =>
                await runtimeClient!.integrations
                  .search(input, { signal })
                  .catch(remoteFailure),
              describe: async (input, signal) =>
                await runtimeClient!.integrations
                  .describe(input, { signal })
                  .catch(remoteFailure),
              invoke: async (input, signal) =>
                await runtimeClient!.integrations
                  .invoke(input, { signal })
                  .catch(remoteFailure),
            },
      remoteConnections:
        applicationConfig.server.runtime === undefined
          ? undefined
          : (() => {
              const client = runtimeClient!;
              const failed = (cause: unknown) =>
                new WorkspaceServerStartupError({
                  detail: "control-plane connection setup",
                  cause,
                });
              return {
                catalog: async () =>
                  await client.integrations
                    .catalog(undefined, { signal: AbortSignal.timeout(10_000) })
                    .catch(failed),
                startSetup: async (input: {
                  integration: string;
                  connectionName?: string;
                }) =>
                  await client.integrations
                    .startSetup(input, { signal: AbortSignal.timeout(10_000) })
                    .catch(failed),
                setup: async (input: { setupId: string }) =>
                  await client.integrations
                    .setup(input, { signal: AbortSignal.timeout(10_000) })
                    .catch(failed),
                cancelSetup: async (input: { setupId: string }) =>
                  await client.integrations
                    .cancelSetup(input, { signal: AbortSignal.timeout(10_000) })
                    .then(() => undefined)
                    .catch(failed),
              };
            })(),
      llmApi,
      reportRoutineSchedule:
        applicationConfig.server.runtime === undefined
          ? undefined
          : (() => {
              const reporter = new ControlPlaneRoutineReporter(
                applicationConfig.server.runtime,
              );
              return async (snapshot, signal) =>
                await reporter.report(snapshot, signal);
            })(),
      reportWorkIdle:
        applicationConfig.server.runtime === undefined
          ? undefined
          : (() => {
              const reporter = new ControlPlaneWorkReporter(
                applicationConfig.server.runtime,
              );
              return async (idle: boolean, signal: AbortSignal) =>
                await reporter.report(idle, signal);
            })(),
      traceUploader:
        applicationConfig.server.runtime === undefined
          ? undefined
          : new ControlPlaneTraceUploader({
              origin: applicationConfig.server.runtime.origin,
              token: applicationConfig.server.runtime.token,
            }),
      logger: logger.scope("rpc"),
    },
  });
  if (server instanceof Error) return server;
  cleanup.defer(async () => {
    const closed = await server.close();
    if (closed instanceof Error) console.error(closed);
  });
  const ready = server.ready;
  const cliPublished = await writeHaloRpcFile({
    userDataDir: applicationConfig.server.appDataDir,
    connection: ready.connections.cli,
  });
  if (cliPublished instanceof Error) return cliPublished;
  cleanup.defer(async () => {
    const removed = await removeHaloRpcFile({
      userDataDir: applicationConfig.server.appDataDir,
    });
    if (removed instanceof Error) console.error(removed);
  });
  const renderer = ready.connections.renderer;
  const published = await writeWorkspaceServerConnection({
    appDataDir: applicationConfig.server.appDataDir,
    connection: {
      workspaceRoot: ready.workspace.workspaceRoot,
      origin: `http://${renderer.host}:${renderer.port}`,
      token: renderer.token,
    },
  });
  if (published instanceof Error) return published;
  cleanup.defer(async () => {
    const removed = await removeWorkspaceServerConnection(
      applicationConfig.server.appDataDir,
    );
    if (removed instanceof Error) console.error(removed);
  });
  console.log(`Workspace server ready for ${ready.workspace.workspaceRoot}`);
  if (process.connected) process.send?.(ready);

  await stopping;
}

// oxlint-disable-next-line typescript/no-floating-promises -- This entry point owns the process lifetime and exits after service cleanup.
run().then((result) => {
  if (result instanceof Error) console.error(result);
  process.exit(result instanceof Error ? 1 : 0);
});
