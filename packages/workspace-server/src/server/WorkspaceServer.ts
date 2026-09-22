import { HotkeyService } from "../hotkeys/HotkeyService.js";
import { createHotkeysPlugin } from "../hotkeys/createHotkeysPlugin.js";
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
import {
  ToolRuntime,
  type GoogleWebOAuthClient,
} from "../agent/runtime/ToolRuntime.js";
import { workspaceBashPlugin } from "../agent/tools/bash/workspaceBashPlugin.js";
import { createWorkspaceFilesPlugin } from "../agent/tools/files/createWorkspaceFilesPlugin.js";
import { parallelSearchPlugin } from "../agent/tools/web/parallelSearchPlugin.js";
import type { LLMApi } from "../llm/LLMApi.js";
import { TraceService, type TraceUploader } from "../traces/TraceService.js";
import type { HaloEnvironment } from "../agent/workspacePrompt.js";
import {
  closeHaloHttp,
  listenHaloHttp,
  serveHaloHttp,
  type ListeningHaloHttp,
  type ServingHaloHttp,
  type WorkspaceGatewayIdentity,
} from "./http.js";
import type { WorkspaceServerReady } from "./WorkspaceServerReady.js";

export type WorkspaceServerConfig = {
  environment: HaloEnvironment;
  workspaceRoot: string;
  appDataDir: string;
  appVersion: string;
  build?: { version: string; revision: string };
  ownerUserId: string;
  host: string;
  port: number;
  corsOrigins: readonly string[];
  testApiEnabled?: boolean;
  traceWorkspaceId?: string;
  gateway?: WorkspaceGatewayIdentity;
  cliEntry?: string;
  cliNodeExecutable?: string;
  cliElectronRunAsNode?: boolean;
  extensionRuntime: ExtensionRuntime;
  googleWebOAuthClient?: GoogleWebOAuthClient;
  oauthTestOrigin?: string;
};

export type WorkspaceServerHost = {
  // Inference client the host constructs and keeps for this process.
  llmApi: LLMApi;
  // Optional upload transport the host owns; the server submits completed traces through it.
  traceUploader?: TraceUploader;
  // Logger the host owns; the server writes through it and does not close the sinks.
  logger: Logger;
  // Host-owned vault. The server passes its FilesystemService; the host must not close it.
  createCredentialVault: (input: {
    filesystem: FilesystemService;
    workspaceRoot: string;
  }) => CredentialVault;
};

export type WorkspaceServerOptions = {
  config: WorkspaceServerConfig;
  host: WorkspaceServerHost;
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
  private readonly traces: TraceService;

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
    traces: TraceService;
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
      traces,
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
    this.traces = traces;
  }

  static async start(
    options: WorkspaceServerOptions,
  ): Promise<WorkspaceServer | Error> {
    const { config, host } = options;
    await using cleanup = new errore.AsyncDisposableStack();
    const http = await listenHaloHttp({
      host: config.host,
      port: config.port,
    });
    if (http instanceof Error) return http;
    cleanup.defer(async () => {
      const closed = await closeHaloHttp(http);
      if (closed instanceof Error)
        host.logger.warn({ event: "http-cleanup-failed", error: closed });
    });
    const filesystem = new FilesystemService();
    cleanup.defer(async () => {
      const closed = await filesystem.close();
      if (closed instanceof Error)
        host.logger.warn({
          event: "filesystem-cleanup-failed",
          error: closed,
        });
    });

    const workspace = await WorkspaceService.create({
      workspaceRoot: config.workspaceRoot,
      appDataDir: config.appDataDir,
      filesystem,
      appVersion: config.appVersion,
      cliEntry: config.cliEntry,
      cliNodeExecutable: config.cliNodeExecutable,
      cliElectronRunAsNode: config.cliElectronRunAsNode,
    });
    if (!(workspace instanceof Error)) cleanup.defer(() => workspace.close());
    if (workspace instanceof Error) return workspace;

    const workspaceRoot = workspace.layout.root;
    const traces = await TraceService.open({
      directory: path.join(workspaceRoot, ".halo", "traces"),
      appVersion: config.appVersion,
      logger: host.logger,
      uploader: host.traceUploader,
      workspaceId: config.traceWorkspaceId,
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
        host.logger.warn({
          event: "database-cleanup-failed",
          error: closed,
        });
    });
    const sessionRepo = await TursoSessionRepo.open(database);
    if (sessionRepo instanceof Error) return sessionRepo;
    cleanup.defer(async () => {
      const closed = await sessionRepo.close();
      if (closed instanceof Error)
        host.logger.warn({
          event: "session-repo-cleanup-failed",
          error: closed,
        });
    });
    const hotkeys = await HotkeyService.open({
      database,
      userId: config.ownerUserId,
    });
    if (hotkeys instanceof Error) return hotkeys;
    const [initialized, toolRuntime] = await Promise.all([
      workspace.initialize(),
      ToolRuntime.create({
        database,
        workspaceRoot,
        userId: config.ownerUserId,
        credentialVault: host.createCredentialVault({
          filesystem,
          workspaceRoot,
        }),
        oauthRedirectUri: `${http.origin}/oauth/callback`,
        googleWebOAuthClient: config.googleWebOAuthClient,
        oauthTestOrigin: config.oauthTestOrigin,
        toolPlugins: [
          createWorkspaceFilesPlugin(filesystem),
          createHotkeysPlugin(hotkeys),
          workspaceBashPlugin,
          parallelSearchPlugin,
        ],
        authority: new StaticAgentAuthority([
          "workspace.hotkeys",
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
          host.logger.warn({
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
      logger: host.logger,
      runtime: config.extensionRuntime,
    });
    cleanup.defer(async () => await extensions.stop());
    const browsers = new BrowserService();
    cleanup.defer(async () => await browsers.shutdown());
    const sessions = new SessionRegistry({
      environment: config.environment,
      repo: sessionRepo,
      llmApi: host.llmApi,
      traces,
      model: host.llmApi.model,
      filesystem,
      layout: workspace.layout,
      toolRuntime,
    });
    cleanup.defer(async () => {
      const closed = await sessions.shutdown();
      if (closed instanceof Error)
        host.logger.warn({
          event: "sessions-cleanup-failed",
          error: closed,
        });
    });
    const connectionService = new ConnectionService(toolRuntime);
    cleanup.defer(() => connectionService.close());
    const requests = serveHaloHttp({
      ...http,
      context: {
        build: config.build,
        hotkeys,
        traces,
        browsers,
        extensions,
        workspace,
        sessions,
        connections: connectionService,
        toolRuntime,
        logger: host.logger,
        browserControlAllowed: false,
        testApiEnabled: config.testApiEnabled === true,
      },
      corsOrigins: config.corsOrigins,
      gateway: config.gateway,
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
      traces,
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
    await this.traces.close();
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
