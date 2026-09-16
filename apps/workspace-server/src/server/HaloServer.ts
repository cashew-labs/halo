import path from "node:path";
import { TursoSessionRepo } from "../storage/TursoSessionRepo.js";
import { DatabaseClient } from "../storage/DatabaseClient.js";
import { BrowserService } from "../browser/BrowserService.js";
import type { Logger } from "@get-halo/logger";
import * as errore from "errore";
import { FilesystemService } from "../filesystem/FilesystemService.js";
import {
  closeHaloHttp,
  listenHaloHttp,
  serveHaloHttp,
  type ListeningHaloHttp,
  type ServingHaloHttp,
  type WorkspaceGatewayIdentity,
} from "./http.js";
import { ExtensionHost } from "../extensions/ExtensionHost.js";
import type { ExtensionRuntime } from "../extensions/startExtension.js";
import type { HaloContext } from "./router.js";
import { SessionRegistry } from "../sessions/SessionRegistry.js";
import { WorkspaceService } from "../workspace/WorkspaceService.js";
import { StaticAgentAuthority } from "../agent/runtime/AgentAuthority.js";
import type { CredentialVault } from "../agent/runtime/CredentialVault.js";
import { ConnectionService } from "../agent/runtime/ConnectionService.js";
import { ToolRuntime } from "../agent/runtime/ToolRuntime.js";
import { workspaceBashPlugin } from "../agent/tools/bash/workspaceBashPlugin.js";
import { createWorkspaceFilesPlugin } from "../agent/tools/files/createWorkspaceFilesPlugin.js";
import { parallelSearchPlugin } from "../agent/tools/web/parallelSearchPlugin.js";
import type { LLMApi } from "../llm/LLMApi.js";
import { TraceService, type TraceUploader } from "../traces/TraceService.js";
import type { HaloEnvironment } from "../agent/workspacePrompt.js";
import type { GoogleWebOAuthClient } from "@get-halo/config/workspaceServer";

export type HaloServerOptions = {
  environment: HaloEnvironment;
  llmApi: LLMApi;
  traceUploader?: TraceUploader;
  workspaceRoot: string;
  appDataDir: string;
  appVersion: string;
  cliEntry?: string;
  cliNodeExecutable?: string;
  cliElectronRunAsNode?: boolean;
  extensionRuntime?: ExtensionRuntime;
  gateway?: WorkspaceGatewayIdentity;
  googleWebOAuthClient?: GoogleWebOAuthClient;
  testingApiEnabled?: boolean;
  ownerUserId: Promise<string | Error>;
  logger: Logger;
  createCredentialVault: (input: {
    filesystem: FilesystemService;
    workspaceRoot: string;
  }) => CredentialVault;
};

export class HaloServer {
  private constructor(
    private readonly resources: {
      context: HaloContext;
      filesystem: FilesystemService;
      database: DatabaseClient;
      sessionRepo: TursoSessionRepo;
      http: ListeningHaloHttp;
      requests: ServingHaloHttp;
      traces: TraceService;
    },
  ) {}

  static async start(
    options: HaloServerOptions & {
      host: string;
      port: number;
      corsOrigins: readonly string[];
    },
  ): Promise<HaloServer | Error> {
    await using cleanup = new errore.AsyncDisposableStack();
    const filesystem = new FilesystemService();
    cleanup.defer(async () => {
      const closed = await filesystem.close();
      if (closed instanceof Error)
        options.logger.warn({
          event: "filesystem-cleanup-failed",
          error: closed,
        });
    });

    const [workspace, http, ownerUserId] = await Promise.all([
      WorkspaceService.create({
        workspaceRoot: options.workspaceRoot,
        appDataDir: options.appDataDir,
        filesystem,
        appVersion: options.appVersion,
        cliEntry: options.cliEntry,
        cliNodeExecutable: options.cliNodeExecutable,
        cliElectronRunAsNode: options.cliElectronRunAsNode,
      }),
      listenHaloHttp({ host: options.host, port: options.port }),
      options.ownerUserId,
    ]);
    if (!(workspace instanceof Error)) cleanup.defer(() => workspace.close());
    if (!(http instanceof Error))
      cleanup.defer(async () => {
        const closed = await closeHaloHttp(http);
        if (closed instanceof Error)
          options.logger.warn({ event: "http-cleanup-failed", error: closed });
      });
    if (workspace instanceof Error) return workspace;
    if (http instanceof Error) return http;
    if (ownerUserId instanceof Error) return ownerUserId;

    const workspaceRoot = workspace.layout.root;
    const traces = await TraceService.open({
      directory: path.join(workspaceRoot, ".halo", "traces"),
      appVersion: options.appVersion,
      logger: options.logger,
      uploader: options.traceUploader,
    });
    if (traces instanceof Error) return traces;
    cleanup.defer(async () => await traces.close());
    const database = await DatabaseClient.open({
      directory: path.join(workspaceRoot, ".halo"),
      filesystem,
    });
    if (database instanceof Error) return database;
    cleanup.defer(async () => {
      const closed = await database.close();
      if (closed instanceof Error)
        options.logger.warn({
          event: "database-cleanup-failed",
          error: closed,
        });
    });
    const sessionRepo = await TursoSessionRepo.open(database);
    if (sessionRepo instanceof Error) return sessionRepo;
    cleanup.defer(async () => {
      const closed = await sessionRepo.close();
      if (closed instanceof Error)
        options.logger.warn({
          event: "session-repo-cleanup-failed",
          error: closed,
        });
    });
    const [initialized, toolRuntime] = await Promise.all([
      workspace.initialize(),
      ToolRuntime.create({
        database,
        workspaceRoot,
        userId: ownerUserId,
        credentialVault: options.createCredentialVault({
          filesystem,
          workspaceRoot,
        }),
        oauthRedirectUri: `${http.origin}/oauth/callback`,
        googleWebOAuthClient: options.googleWebOAuthClient,
        toolPlugins: [
          createWorkspaceFilesPlugin(filesystem),
          workspaceBashPlugin,
          parallelSearchPlugin,
        ],
        authority: new StaticAgentAuthority([
          "workspace.files.read",
          "workspace.files.write",
          "workspace.shell.execute",
          "network.web.search",
        ]),
      }),
    ]);
    if (!(toolRuntime instanceof Error))
      cleanup.defer(async () => {
        const closed = await toolRuntime.close();
        if (closed instanceof Error)
          options.logger.warn({
            event: "tool-runtime-cleanup-failed",
            error: closed,
          });
      });
    if (initialized instanceof Error) return initialized;
    if (toolRuntime instanceof Error) return toolRuntime;

    const extensions = new ExtensionHost({
      workspaceRoot,
      toolsOrigin: http.origin,
      filesystem,
      logger: options.logger,
      runtime:
        options.extensionRuntime === undefined
          ? { executable: process.execPath, electronRunAsNode: false }
          : options.extensionRuntime,
    });
    cleanup.defer(async () => await extensions.stop());
    const context: HaloContext = {
      traces,
      browsers: new BrowserService(),
      browserControlAllowed: false,
      extensions,
      workspace,
      sessions: new SessionRegistry({
        environment: options.environment,
        repo: sessionRepo,
        llmApi: options.llmApi,
        traces,
        model: options.llmApi.model,
        filesystem,
        layout: workspace.layout,
        toolRuntime,
      }),
      connections: new ConnectionService(toolRuntime),
      toolRuntime,
      logger: options.logger,
      testingApiEnabled: options.testingApiEnabled === true,
    };
    cleanup.defer(async () => {
      const closed = await context.sessions.shutdown();
      if (closed instanceof Error)
        options.logger.warn({
          event: "sessions-cleanup-failed",
          error: closed,
        });
    });
    const requests = serveHaloHttp({
      ...http,
      context,
      corsOrigins: options.corsOrigins,
      gateway: options.gateway,
    });
    cleanup.defer(async () => await requests.close());
    await extensions.reload();
    cleanup.move();
    return new HaloServer({
      context,
      filesystem,
      database,
      sessionRepo,
      http,
      requests,
      traces,
    });
  }

  get connections() {
    return this.resources.http.connections;
  }

  getWorkspace() {
    return this.resources.context.workspace.getWorkspace();
  }

  async close() {
    const {
      context,
      filesystem,
      database,
      sessionRepo,
      http,
      requests,
      traces,
    } = this.resources;
    await requests.close();
    context.connections.close();
    const sessionsClosed = await context.sessions.shutdown();
    await traces.close();
    await context.browsers.shutdown();
    await context.extensions.stop();
    const runtimeClosed = await context.toolRuntime.close();
    const repoClosed = await sessionRepo.close();
    const databaseClosed = await database.close();
    const httpClosed = await closeHaloHttp(http);
    context.workspace.close();
    const filesystemClosed = await filesystem.close();

    if (httpClosed instanceof Error) return httpClosed;
    if (sessionsClosed instanceof Error) return sessionsClosed;
    if (runtimeClosed instanceof Error) return runtimeClosed;
    if (repoClosed instanceof Error) return repoClosed;
    if (databaseClosed instanceof Error) return databaseClosed;
    if (filesystemClosed instanceof Error) return filesystemClosed;
  }
}
