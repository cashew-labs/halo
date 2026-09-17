import path from "node:path";
import { TursoSessionRepo } from "../storage/TursoSessionRepo.js";
import { DatabaseClient } from "../storage/DatabaseClient.js";
import { BrowserService } from "../browser/BrowserService.js";
import type { Logger } from "@get-halo/logger";
import * as errore from "errore";
import { FilesystemService } from "../filesystem/FilesystemService.js";
import { ExtensionHost } from "../extensions/ExtensionHost.js";
import type { ExtensionRuntime } from "../extensions/startExtension.js";
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
import { createPiModelRuntime } from "../llm/createPiModelRuntime.js";
import type { HaloEnvironment } from "../agent/workspacePrompt.js";
import type { GoogleWebOAuthClient } from "@get-halo/config/workspaceServer";
import {
  closeHaloHttp,
  listenHaloHttp,
  serveHaloHttp,
  type ListeningHaloHttp,
  type ServingHaloHttp,
  type WorkspaceGatewayIdentity,
} from "./http.js";
import type { WorkspaceServerReady } from "./WorkspaceServerReady.js";

export type WorkspaceServerOptions = {
  environment: HaloEnvironment;
  llmApi: LLMApi;
  workspaceRoot: string;
  appDataDir: string;
  appVersion: string;
  cliEntry?: string;
  cliNodeExecutable?: string;
  cliElectronRunAsNode?: boolean;
  extensionRuntime?: ExtensionRuntime;
  googleWebOAuthClient?: GoogleWebOAuthClient;
  host: string;
  port: number;
  corsOrigins: readonly string[];
  testApiEnabled?: boolean;
  gateway?: WorkspaceGatewayIdentity;
  ownerUserId: Promise<string | Error>;
  logger: Logger;
  createCredentialVault: (input: {
    filesystem: FilesystemService;
    workspaceRoot: string;
  }) => CredentialVault;
};

export class WorkspaceServer {
  private readonly filesystem: FilesystemService;
  private readonly database: DatabaseClient;
  private readonly sessionRepo: TursoSessionRepo;
  private readonly workspace: WorkspaceService;
  private readonly sessions: SessionRegistry;
  private readonly toolRuntime: ToolRuntime;
  private readonly connectionService: ConnectionService;
  private readonly browsers: BrowserService;
  private readonly extensions: ExtensionHost;
  private readonly http: ListeningHaloHttp;
  private readonly requests: ServingHaloHttp;

  private constructor(ctx: {
    filesystem: FilesystemService;
    database: DatabaseClient;
    sessionRepo: TursoSessionRepo;
    workspace: WorkspaceService;
    sessions: SessionRegistry;
    toolRuntime: ToolRuntime;
    connectionService: ConnectionService;
    browsers: BrowserService;
    extensions: ExtensionHost;
    http: ListeningHaloHttp;
    requests: ServingHaloHttp;
  }) {
    const {
      filesystem,
      database,
      sessionRepo,
      workspace,
      sessions,
      toolRuntime,
      connectionService,
      browsers,
      extensions,
      http,
      requests,
    } = ctx;
    this.filesystem = filesystem;
    this.database = database;
    this.sessionRepo = sessionRepo;
    this.workspace = workspace;
    this.sessions = sessions;
    this.toolRuntime = toolRuntime;
    this.connectionService = connectionService;
    this.browsers = browsers;
    this.extensions = extensions;
    this.http = http;
    this.requests = requests;
  }

  static async start(
    options: WorkspaceServerOptions,
  ): Promise<WorkspaceServer | Error> {
    await using cleanup = new errore.AsyncDisposableStack();
    const http = await listenHaloHttp({
      host: options.host,
      port: options.port,
    });
    if (http instanceof Error) return http;
    cleanup.defer(async () => {
      const closed = await closeHaloHttp(http);
      if (closed instanceof Error)
        options.logger.warn({ event: "http-cleanup-failed", error: closed });
    });
    const modelRuntime = await createPiModelRuntime(options.llmApi);
    if (modelRuntime instanceof Error) return modelRuntime;
    const filesystem = new FilesystemService();
    cleanup.defer(async () => {
      const closed = await filesystem.close();
      if (closed instanceof Error)
        options.logger.warn({
          event: "filesystem-cleanup-failed",
          error: closed,
        });
    });

    const [workspace, ownerUserId] = await Promise.all([
      WorkspaceService.create({
        workspaceRoot: options.workspaceRoot,
        appDataDir: options.appDataDir,
        filesystem,
        appVersion: options.appVersion,
        cliEntry: options.cliEntry,
        cliNodeExecutable: options.cliNodeExecutable,
        cliElectronRunAsNode: options.cliElectronRunAsNode,
      }),
      options.ownerUserId,
    ]);
    if (!(workspace instanceof Error)) cleanup.defer(() => workspace.close());
    if (workspace instanceof Error) return workspace;
    if (ownerUserId instanceof Error) return ownerUserId;

    const workspaceRoot = workspace.layout.root;
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
    const browsers = new BrowserService();
    cleanup.defer(async () => await browsers.shutdown());
    const sessions = new SessionRegistry({
      environment: options.environment,
      repo: sessionRepo,
      modelRuntime,
      model: options.llmApi.model,
      filesystem,
      layout: workspace.layout,
      toolRuntime,
    });
    cleanup.defer(async () => {
      const closed = await sessions.shutdown();
      if (closed instanceof Error)
        options.logger.warn({
          event: "sessions-cleanup-failed",
          error: closed,
        });
    });
    const connectionService = new ConnectionService(toolRuntime);
    cleanup.defer(() => connectionService.close());
    const requests = serveHaloHttp({
      ...http,
      context: {
        browsers,
        extensions,
        workspace,
        sessions,
        connections: connectionService,
        toolRuntime,
        logger: options.logger,
        browserControlAllowed: false,
        testApiEnabled: options.testApiEnabled === true,
      },
      corsOrigins: options.corsOrigins,
      gateway: options.gateway,
    });
    cleanup.defer(async () => await requests.close());
    await extensions.reload();
    cleanup.move();
    return new WorkspaceServer({
      filesystem,
      database,
      sessionRepo,
      workspace,
      sessions,
      toolRuntime,
      connectionService,
      browsers,
      extensions,
      http,
      requests,
    });
  }

  get ready(): WorkspaceServerReady {
    return {
      workspace: this.workspace.getWorkspace(),
      connections: this.http.connections,
    };
  }

  async close() {
    await this.requests.close();
    this.connectionService.close();
    const sessionsClosed = await this.sessions.shutdown();
    await this.browsers.shutdown();
    await this.extensions.stop();
    const toolsClosed = await this.toolRuntime.close();
    const repoClosed = await this.sessionRepo.close();
    const databaseClosed = await this.database.close();
    const httpClosed = await closeHaloHttp(this.http);
    this.workspace.close();
    const filesystemClosed = await this.filesystem.close();

    if (httpClosed instanceof Error) return httpClosed;
    if (sessionsClosed instanceof Error) return sessionsClosed;
    if (toolsClosed instanceof Error) return toolsClosed;
    if (repoClosed instanceof Error) return repoClosed;
    if (databaseClosed instanceof Error) return databaseClosed;
    if (filesystemClosed instanceof Error) return filesystemClosed;
  }
}
