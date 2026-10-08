import { AutomationSources } from "../automations/AutomationSources.js";
import type { ControlPlaneAutomationClient } from "../automations/ControlPlaneAutomationClient.js";
import { AutomationSync } from "../automations/AutomationSync.js";
import { createAutomationsPlugin } from "../automations/createAutomationsPlugin.js";
import { AutomationRunner } from "../automations/AutomationRunner.js";
import { HotkeyService } from "../hotkeys/HotkeyService.js";
import { WorkspaceIdleReporter } from "./WorkspaceIdleReporter.js";
import { combineLatest } from "@get-halo/shared/Stream";
import { RoutineService } from "../routines/RoutineService.js";
import { RoutineRunner } from "../routines/RoutineRunner.js";
import { RoutineScheduler } from "../routines/RoutineScheduler.js";
import {
  RoutineSync,
  type RoutineScheduleSnapshot,
} from "../routines/RoutineSync.js";
import { createHotkeysPlugin } from "../hotkeys/createHotkeysPlugin.js";
import path from "node:path";
import { TursoThreadRepo } from "../storage/TursoThreadRepo.js";
import { DatabaseClient } from "../storage/DatabaseClient.js";
import { BrowserService } from "../browser/BrowserService.js";
import type { Logger } from "@get-halo/logger";
import * as errore from "errore";
import { FilesystemService } from "../filesystem/FilesystemService.js";
import { ExtensionHost } from "../extensions/ExtensionHost.js";
import type { ExtensionRuntime } from "../extensions/startExtension.js";
import { ThreadManager } from "../sessions/ThreadManager.js";
import { createThreadPlugin } from "../sessions/createThreadPlugin.js";
import { WorkspaceService } from "../workspace/WorkspaceService.js";
import { WorkspaceSearch } from "../workspace/WorkspaceSearch.js";
import { StaticAgentAuthority } from "../agent/runtime/AgentAuthority.js";
import { ConnectionService } from "../agent/runtime/ConnectionService.js";
import {
  ToolRuntime,
  type RemoteIntegrationTools,
} from "../agent/runtime/ToolRuntime.js";
import { workspaceBashPlugin } from "../agent/tools/bash/workspaceBashPlugin.js";
import { createWorkspaceFilesPlugin } from "../agent/tools/files/createWorkspaceFilesPlugin.js";
import { createDatabaseQueryPlugin } from "../agent/tools/database/createDatabaseQueryPlugin.js";
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
  legacyExecutorTenant?: string;
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
  desktopOrigin?: string;
  cliEntry?: string;
  cliNodeExecutable?: string;
  cliElectronRunAsNode?: boolean;
  extensionRuntime: ExtensionRuntime;
};

export type WorkspaceServerHost = {
  automationControl?: Pick<
    ControlPlaneAutomationClient,
    "report" | "status" | "webhookAccess"
  >;
  remoteConnections?: import("../agent/runtime/ConnectionService.js").RemoteConnectionBackend;
  remoteIntegrationTools?: RemoteIntegrationTools;
  reportRoutineSchedule?: (
    snapshot: RoutineScheduleSnapshot,
    signal: AbortSignal,
  ) => Promise<void | Error>;
  reportWorkIdle?: (
    idle: boolean,
    signal: AbortSignal,
  ) => Promise<void | Error>;
  // Inference client the host constructs and keeps for this process.
  llmApi: LLMApi;
  // Host-granted tool capabilities; omitted uses the standard workspace grants.
  agentCapabilities?: readonly string[];
  // Optional upload transport the host owns; the server submits completed traces through it.
  traceUploader?: TraceUploader;
  // Logger the host owns; the server writes through it and does not close the sinks.
  logger: Logger;
};

export type WorkspaceServerOptions = {
  config: WorkspaceServerConfig;
  host: WorkspaceServerHost;
};

export class WorkspaceServer {
  private readonly idleReporter: WorkspaceIdleReporter;

  get idle() {
    return this.idleReporter.idle;
  }
  private readonly filesystem: FilesystemService;
  private readonly database: DatabaseClient;
  private readonly sessionRepo: TursoThreadRepo;
  private readonly workspace: WorkspaceService;
  private readonly sessions: ThreadManager;
  private readonly automationRunner: AutomationRunner;
  private readonly automationSync: AutomationSync | undefined;
  private readonly routineScheduler: RoutineScheduler | RoutineSync;
  private readonly toolRuntime: ToolRuntime;
  private readonly connectionService: ConnectionService;
  private readonly browsers: BrowserService;
  private readonly extensions: ExtensionHost;
  private readonly http: ListeningHaloHttp;
  private readonly requests: ServingHaloHttp;
  private readonly traces: TraceService;

  private constructor(ctx: {
    idleReporter: WorkspaceIdleReporter;
    filesystem: FilesystemService;
    database: DatabaseClient;
    sessionRepo: TursoThreadRepo;
    workspace: WorkspaceService;
    sessions: ThreadManager;
    automationRunner: AutomationRunner;
    routineScheduler: RoutineScheduler | RoutineSync;
    automationSync: AutomationSync | undefined;
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
      automationRunner,
      routineScheduler,
      automationSync,
      toolRuntime,
      connectionService,
      browsers,
      extensions,
      http,
      requests,
      traces,
    } = ctx;
    this.idleReporter = ctx.idleReporter;
    this.filesystem = filesystem;
    this.database = database;
    this.sessionRepo = sessionRepo;
    this.workspace = workspace;
    this.sessions = sessions;
    this.automationRunner = automationRunner;
    this.routineScheduler = routineScheduler;
    this.automationSync = automationSync;
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
      llmApi: host.llmApi,
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
      executorTenantMigration:
        config.legacyExecutorTenant === undefined
          ? undefined
          : {
              fromTenant: config.legacyExecutorTenant,
              toTenant: workspaceRoot,
            },
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
    const sessionRepo = new TursoThreadRepo(database);
    const search = new WorkspaceSearch({ workspace, repo: sessionRepo });
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
    const routines = await RoutineService.open({ database });
    if (routines instanceof Error) return routines;
    const [initialized, toolRuntime] = await Promise.all([
      workspace.initialize(),
      ToolRuntime.create({
        remoteConnections: host.remoteConnections,
        remoteIntegrationTools: host.remoteIntegrationTools,
        database,
        workspaceRoot,
        userId: config.ownerUserId,
        toolPlugins: [
          createWorkspaceFilesPlugin(filesystem),
          createDatabaseQueryPlugin(database),
          createHotkeysPlugin(hotkeys),
          createAutomationsPlugin(() => ({
            automations: routines.automations,
            runner: automationRunner,
            sources: automationSources,
          })),
          createThreadPlugin(() => ({
            threads: sessions,
            connections: connectionService,
          })),
          workspaceBashPlugin,
          parallelSearchPlugin,
        ],
        authority: new StaticAgentAuthority(
          host.agentCapabilities ?? [
            "workspace.hotkeys",
            "workspace.automations",
            "workspace.files.read",
            "workspace.files.write",
            "workspace.shell.execute",
            "workspace.threads.read",
            "workspace.threads.write",
            "network.web.search",
          ],
        ),
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

    const connectionService = new ConnectionService({
      remote: host.remoteConnections,
    });
    cleanup.defer(() => connectionService.close());
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
    const sessions = new ThreadManager({
      environment: config.environment,
      repo: sessionRepo,
      llmApi: host.llmApi,
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
    const automationRunner = new AutomationRunner({
      automations: routines.automations,
      sessions,
      filesystem,
      workspaceRoot,
      logger: host.logger,
    });
    const routineRunner = new RoutineRunner({
      automations: automationRunner,
      routines,
    });
    cleanup.defer(async () => await automationRunner.stop());
    const recoveredRoutines = await automationRunner.recover({
      preserveDue: host.reportRoutineSchedule !== undefined,
    });
    if (recoveredRoutines instanceof Error) return recoveredRoutines;
    const recovered = await sessions.start();
    if (recovered instanceof Error) return recovered;
    await automationRunner.startWorker();
    const idleReporter = new WorkspaceIdleReporter({
      idle: combineLatest([
        sessions.idle,
        toolRuntime.idle,
        automationRunner.idle,
      ]).map((states) => states.every(Boolean)),
      report: host.reportWorkIdle,
    });
    cleanup.defer(async () => await idleReporter.close());
    const routineScheduler =
      host.reportRoutineSchedule === undefined
        ? new RoutineScheduler({
            routines,
            runner: routineRunner,
            logger: host.logger,
          })
        : new RoutineSync({
            routines,
            report: host.reportRoutineSchedule,
            logger: host.logger,
          });
    cleanup.defer(async () => await routineScheduler.stop());
    const automationSync =
      host.automationControl === undefined
        ? undefined
        : new AutomationSync({
            automations: routines.automations,
            report: async (snapshot, signal) =>
              await host.automationControl!.report(snapshot, signal),
            logger: host.logger,
          });
    automationSync?.start();
    cleanup.defer(async () => await automationSync?.close());
    const automationSources = new AutomationSources({
      automations: routines.automations,
      sync: automationSync,
      control: host.automationControl,
    });
    const requests = serveHaloHttp({
      ...http,
      context: {
        build: config.build,
        hotkeys,
        routines,
        routineRunner,
        automationSources,
        traces,
        browsers,
        extensions,
        workspace,
        search,
        sessions,
        connections: connectionService,
        toolRuntime,
        logger: host.logger,
        browserControlAllowed: false,
        testApiEnabled: config.testApiEnabled === true,
      },
      corsOrigins: config.corsOrigins,
      gateway: config.gateway,
      desktopOrigin: config.desktopOrigin,
    });
    cleanup.defer(async () => await requests.close());
    await extensions.reload();
    const scheduled = await routineScheduler.start();
    if (scheduled instanceof Error) return scheduled;
    cleanup.move();
    return new WorkspaceServer({
      idleReporter,
      filesystem,
      database,
      sessionRepo,
      workspace,
      sessions,
      automationRunner,
      routineScheduler,
      automationSync,
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
    await this.idleReporter.close();
    await this.requests.close();
    this.connectionService.close();
    // Routine runs record their interruption before their sessions close.
    await this.routineScheduler.stop();
    await this.automationSync?.close();
    await this.automationRunner.stop();
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
