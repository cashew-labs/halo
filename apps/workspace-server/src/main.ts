import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "@get-halo/config/workspaceServer";
import { ApplicationMode } from "@get-halo/config/ApplicationMode";
import { Logger } from "@get-halo/logger";
import { JsonlLoggerSink } from "@get-halo/logger/JsonlLoggerSink";
import {
  writeWorkspaceServerConnection,
  removeWorkspaceServerConnection,
} from "@get-halo/shared/WorkspaceServerConnection";
import * as errore from "errore";
import {
  WorkspaceServer,
  ControlPlaneTraceUploader,
} from "./server/WorkspaceServer.js";
import { GoogleAuth } from "google-auth-library";
import { writeHaloRpcFile, removeHaloRpcFile } from "./server/haloRpcFile.js";
import { FileCredentialVault } from "./agent/runtime/FileCredentialVault.js";
import { createPiLLMApi } from "./llm/createPiLLMApi.js";
import { createOpenAILLMApi } from "./llm/createOpenAILLMApi.js";

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
  if (config instanceof Error) return config;
  const applicationConfig = config;
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
  const server = await WorkspaceServer.start({
    ...applicationConfig.server,
    llmApi,
    traceUploader:
      applicationConfig.server.traceUpload === undefined
        ? undefined
        : new ControlPlaneTraceUploader({
            origin: applicationConfig.server.traceUpload.origin,
            auth: new GoogleAuth(),
          }),
    traceWorkspaceId: applicationConfig.server.traceUpload?.workspaceId,
    gateway: applicationConfig.server.gateway,
    googleWebOAuthClient: applicationConfig.googleWebOAuthClient,
    testApiEnabled: process.env.HALO_E2E === "1",
    ownerUserId: Promise.resolve(applicationConfig.server.ownerUserId),
    logger: logger.scope("rpc"),
    host:
      applicationConfig.mode === ApplicationMode.Production
        ? "0.0.0.0"
        : "127.0.0.1",
    port: applicationConfig.server.port,
    createCredentialVault: ({ filesystem, workspaceRoot }) =>
      new FileCredentialVault({
        filesystem,
        directory: join(workspaceRoot, ".halo", "executor", "credentials"),
      }),
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
