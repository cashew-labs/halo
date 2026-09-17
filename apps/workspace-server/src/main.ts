import fs from "node:fs/promises";
import { dirname, join } from "node:path";
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
  FileCredentialVault,
  WorkspaceServer,
} from "@get-halo/workspace-server";
import {
  createOpenAILLMApi,
  createPiLLMApi,
} from "@get-halo/workspace-server/llm";
import * as errore from "errore";

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
  const llmApi =
    applicationConfig.inference.backend === "openAI"
      ? createOpenAILLMApi(applicationConfig.inference.options)
      : await createPiLLMApi(applicationConfig.inference.options);
  if (llmApi instanceof Error) return llmApi;
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
  const server = await WorkspaceServer.start({
    config: {
      environment: applicationConfig.server.environment,
      workspaceRoot: applicationConfig.server.workspaceRoot,
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
      gateway: applicationConfig.server.gateway,
      cliEntry: applicationConfig.server.cliEntry,
      cliNodeExecutable: applicationConfig.server.cliNodeExecutable,
      cliElectronRunAsNode: applicationConfig.server.cliElectronRunAsNode,
      extensionRuntime,
      googleWebOAuthClient: applicationConfig.googleWebOAuthClient,
      oauthTestOrigin: process.env.HALO_E2E_OAUTH_ORIGIN,
    },
    host: {
      llmApi,
      logger: logger.scope("rpc"),
      createCredentialVault: ({ filesystem, workspaceRoot }) =>
        new FileCredentialVault({
          filesystem,
          directory: join(workspaceRoot, ".halo", "executor", "credentials"),
        }),
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
