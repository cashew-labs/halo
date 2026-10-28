import { WorkspaceMaintenance } from "./WorkspaceMaintenance.js";
import { AutomationService } from "../automations/AutomationService.js";
import { AutomationSources } from "../automations/AutomationSources.js";
import type { ControlPlaneAutomationClient } from "../automations/ControlPlaneAutomationClient.js";
import { AutomationSync } from "../automations/AutomationSync.js";
import { automationTools } from "../automations/automationTools.js";
import { AutomationRunner } from "../automations/AutomationRunner.js";
import { MemoryService } from "../memory/MemoryService.js";
import { memoryTools } from "../memory/memoryTools.js";
import { FavoritesService } from "../favorites/FavoritesService.js";
import { HotkeyService } from "../hotkeys/HotkeyService.js";
import { WorkspaceIdleReporter } from "./WorkspaceIdleReporter.js";
import { combineLatest } from "@get-halo/shared/Stream";
import { AutomationScheduler } from "../automations/AutomationScheduler.js";
import {
  AutomationScheduleSync,
  type AutomationScheduleSnapshot,
} from "../automations/AutomationScheduleSync.js";
import { hotkeyTools } from "../hotkeys/hotkeyTools.js";
import path from "node:path";
import { TursoThreadRepo } from "../database/TursoThreadRepo.js";
import { DatabaseService } from "../database/DatabaseService.js";
import {
  BrowserService,
  type ChromeConfig,
} from "../browser/BrowserService.js";
import { browserTools } from "../browser/browserTools.js";
import { ComputerService } from "../computer/ComputerService.js";
import { computerTools } from "../computer/computerTools.js";
import type { Logger } from "@get-halo/logger";
import * as errore from "errore";
import { FilesystemService } from "../filesystem/FilesystemService.js";
import { ExtensionHost } from "../extensions/ExtensionHost.js";
import type { ExtensionRuntime } from "../extensions/startExtension.js";
import { ThreadManager } from "../threads/ThreadManager.js";
import { threadTools } from "../threads/threadTools.js";
import { WorkspaceService } from "../workspace/WorkspaceService.js";
import { WorkspaceSearch } from "../workspace/WorkspaceSearch.js";
import { StaticAgentAuthority } from "../agent/runtime/AgentAuthority.js";
import { ConnectionService } from "../agent/runtime/ConnectionService.js";
import {
  ToolRuntime,
  type RemoteIntegrationTools,
} from "../agent/runtime/ToolRuntime.js";
import { bashTool } from "../agent/tools/bash/bash.js";
import { readTool } from "../agent/tools/files/read.js";
import { viewImageTool } from "../agent/tools/files/viewImage.js";
import { editTool } from "../agent/tools/files/edit.js";
import { writeTool } from "../agent/tools/files/write.js";
import { patchTool } from "../agent/tools/files/patch.js";
import { deleteTool } from "../agent/tools/files/delete.js";
import { queryTool } from "../agent/tools/database/query.js";
import {
  webTools,
  ParallelSearchService,
} from "../agent/tools/web/parallelSearch.js";
import type { HaloTools } from "../agent/tools/HaloTool.js";
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
import type { SharedAppRuntime } from "../extensions/ExtensionHost.js";
import type { RemoteApps } from "../extensions/appsRouter.js";
import type { AppActions } from "../extensions/AppActionsClient.js";
import { AppConversations } from "../extensions/AppConversations.js";
import { UploadService } from "../uploads/UploadService.js";

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
  // The workspace's headed Chrome; enables the agent browser tools.
  chrome?: ChromeConfig;
  cliEntry?: string;
  cliNodeExecutable?: string;
  cliElectronRunAsNode?: boolean;
  extensionRuntime: ExtensionRuntime;
  sharedApp?: SharedAppRuntime;
};

export type WorkspaceServerHost = {
  automationControl?: Pick<
    ControlPlaneAutomationClient,
    "report" | "status" | "webhookAccess" | "gmailConnections"
  >;
  remoteConnections?: import("../agent/runtime/ConnectionService.js").RemoteConnectionBackend;
  remoteIntegrationTools?: RemoteIntegrationTools;
  // The owner's published apps; absent on app VMs and local-only hosts.
  remoteApps?: RemoteApps;
  // An app VM's owner-fixed integration actions; absent elsewhere.
  appActions?: AppActions;
  reportAutomationSchedule?: (
    snapshot: AutomationScheduleSnapshot,
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
  // Top-level keys are namespaces; omitted uses Halo's base tool registry.
  tools?: Readonly<Record<string, HaloTools>>;
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
  private readonly db: DatabaseService;
  private readonly threadRepo: TursoThreadRepo;
  private readonly workspace: WorkspaceService;
  private readonly threads: ThreadManager;
  private readonly uploads: UploadService;
  private readonly automations: AutomationService;
  private readonly automationRunner: AutomationRunner;
  private readonly automationSync: AutomationSync | undefined;
  private readonly automationScheduler:
    | AutomationScheduler
    | AutomationScheduleSync;
  private readonly toolRuntime: ToolRuntime;
  private readonly web: ParallelSearchService;
  private readonly connectionService: ConnectionService;
  private readonly browsers: BrowserService | undefined;
  private readonly extensions: ExtensionHost;
  private readonly http: ListeningHaloHttp;
  private readonly requests: ServingHaloHttp;
  private readonly traces: TraceService;

  private constructor(ctx: {
    idleReporter: WorkspaceIdleReporter;
    filesystem: FilesystemService;
    db: DatabaseService;
    threadRepo: TursoThreadRepo;
    workspace: WorkspaceService;
    threads: ThreadManager;
    uploads: UploadService;
    automations: AutomationService;
    automationRunner: AutomationRunner;
    automationScheduler: AutomationScheduler | AutomationScheduleSync;
    automationSync: AutomationSync | undefined;
    toolRuntime: ToolRuntime;
    web: ParallelSearchService;
    connectionService: ConnectionService;
    browsers: BrowserService | undefined;
    extensions: ExtensionHost;
    http: ListeningHaloHttp;
    requests: ServingHaloHttp;
    traces: TraceService;
  }) {
    const {
      filesystem,
      db,
      threadRepo,
      workspace,
      threads,
      automations,
      automationRunner,
      automationScheduler,
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
    this.db = db;
    this.threadRepo = threadRepo;
    this.workspace = workspace;
    this.threads = threads;
    this.uploads = ctx.uploads;
    this.automations = automations;
    this.automationRunner = automationRunner;
    this.automationScheduler = automationScheduler;
    this.automationSync = automationSync;
    this.toolRuntime = toolRuntime;
    this.web = ctx.web;
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
    const db = await DatabaseService.open({
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
    if (db instanceof Error) return db;
    cleanup.defer(async () => {
      const closed = await db.close();
      if (closed instanceof Error)
        host.logger.warn({
          event: "database-cleanup-failed",
          error: closed,
        });
    });
    const threadRepo = new TursoThreadRepo(db.createNativeConnection());
    const search = new WorkspaceSearch({ workspace, repo: threadRepo });
    cleanup.defer(async () => {
      const closed = await threadRepo.close();
      if (closed instanceof Error)
        host.logger.warn({
          event: "thread-repo-cleanup-failed",
          error: closed,
        });
    });
    const favorites = new FavoritesService({ db });
    // Shared apps serve viewers other than the owner, so they get no memory.
    const hasMemory = config.sharedApp === undefined;
    const memory = new MemoryService({ db });
    const hotkeys = new HotkeyService({
      db,
      userId: config.ownerUserId,
    });
    const automations = await AutomationService.open({
      db,
    });
    if (automations instanceof Error) return automations;
    cleanup.defer(async () => await automations.close());
    const web = new ParallelSearchService();
    cleanup.defer(async () => {
      const closed = await web.close();
      if (closed instanceof Error)
        host.logger.warn({ event: "web-cleanup-failed", error: closed });
    });
    const hasDesktop =
      config.desktopOrigin !== undefined && config.sharedApp === undefined;
    const computer = new ComputerService({ workspaceRoot });
    cleanup.defer(async () => {
      const closed = await computer.shutdown();
      if (closed instanceof Error)
        host.logger.warn({ event: "computer-cleanup-failed", error: closed });
    });
    const browsers =
      config.chrome === undefined || config.sharedApp !== undefined
        ? undefined
        : new BrowserService({
            chrome: config.chrome,
            workspaceRoot,
          });
    cleanup.defer(async () => await browsers?.shutdown());
    // Threads pin memory into their prompt only when agents can also use it.
    const agentCapabilities = host.agentCapabilities ?? [
      ...(hasDesktop ? ["workspace.computer"] : []),
      ...(browsers === undefined ? [] : ["workspace.browser"]),
      "workspace.hotkeys",
      "workspace.automations",
      ...(hasMemory ? ["workspace.memory"] : []),
      "workspace.files.read",
      "workspace.files.write",
      "workspace.shell.execute",
      "workspace.threads.read",
      "workspace.threads.write",
      "network.web.search",
    ];
    const [initialized, toolRuntime] = await Promise.all([
      workspace.initialize(),
      ToolRuntime.create({
        remoteConnections: host.remoteConnections,
        remoteIntegrationTools: host.remoteIntegrationTools,
        workspaceRoot,
        userId: config.ownerUserId,
        tools: host.tools ?? {
          computer: hasDesktop ? computerTools : {},
          browser: browsers === undefined ? {} : browserTools,
          files: {
            read: readTool,
            viewImage: viewImageTool,
            edit: editTool,
            write: writeTool,
            patch: patchTool,
            delete: deleteTool,
          },
          database: { query: queryTool },
          hotkeys: hotkeyTools,
          automations: automationTools,
          memory: hasMemory ? memoryTools : {},
          thread: threadTools,
          bash: { run: bashTool },
          web: webTools,
        },
        services: {
          filesystem,
          database: db.createNativeConnection(),
          hotkeys,
          automations,
          memory,
          web,
          computer,
          browser: browsers,
          // Threads and automation services borrow the runtime during startup.
          get threads() {
            return threads;
          },
          get connections() {
            return connectionService;
          },
          get automationRunner() {
            return automationRunner;
          },
          get automationSources() {
            return automationSources;
          },
        },
        authority: new StaticAgentAuthority(agentCapabilities),
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
      sharedApp: config.sharedApp,
      remoteApps: host.remoteApps,
    });
    cleanup.defer(async () => await extensions.stop());
    const uploads = new UploadService({ filesystem, workspaceRoot });
    const uploadsStarted = await uploads.start();
    if (uploadsStarted instanceof Error) return uploadsStarted;
    cleanup.defer(() => uploads.close());
    const threads = new ThreadManager({
      environment: config.environment,
      repo: threadRepo,
      db,
      llmApi: host.llmApi,
      filesystem,
      layout: workspace.layout,
      toolRuntime,
      uploads,
      memory: agentCapabilities.includes("workspace.memory")
        ? memory
        : undefined,
    });
    cleanup.defer(async () => {
      const closed = await threads.shutdown();
      if (closed instanceof Error)
        host.logger.warn({
          event: "threads-cleanup-failed",
          error: closed,
        });
    });
    const toolsIdle = toolRuntime.idle.project(
      false,
      (_previous, idle) => idle,
    );
    cleanup.defer(() => toolsIdle[Symbol.dispose]());
    const maintenance = new WorkspaceMaintenance({
      isWorkIdle: () =>
        threads.idle.latestValue &&
        toolsIdle.latestValue &&
        automationRunner.idle.latestValue,
    });
    const automationRunner = new AutomationRunner({
      maintenance,
      automations,
      threads,
      filesystem,
      workspaceRoot,
      logger: host.logger,
    });
    cleanup.defer(async () => await automationRunner.stop());
    const recoveredAutomations = await automationRunner.recover({
      preserveDue: host.reportAutomationSchedule !== undefined,
    });
    if (recoveredAutomations instanceof Error) return recoveredAutomations;
    const recovered = await threads.start();
    if (recovered instanceof Error) return recovered;
    await automationRunner.startWorker();
    const idleReporter = new WorkspaceIdleReporter({
      idle: combineLatest([
        threads.idle,
        toolRuntime.idle,
        automationRunner.idle,
      ]).map((states) => states.every(Boolean)),
      report: host.reportWorkIdle,
    });
    cleanup.defer(async () => await idleReporter.close());
    const automationScheduler =
      host.reportAutomationSchedule === undefined
        ? new AutomationScheduler({
            automations,
            runner: automationRunner,
            logger: host.logger,
          })
        : new AutomationScheduleSync({
            automations,
            report: host.reportAutomationSchedule,
            logger: host.logger,
          });
    cleanup.defer(async () => await automationScheduler.stop());
    const automationSync =
      host.automationControl === undefined
        ? undefined
        : new AutomationSync({
            automations,
            report: async (snapshot, signal) =>
              await host.automationControl!.report(snapshot, signal),
            logger: host.logger,
          });
    automationSync?.start();
    cleanup.defer(async () => await automationSync?.close());
    const automationSources = new AutomationSources({
      automations,
      sync: automationSync,
      control: host.automationControl,
    });
    const requests = serveHaloHttp({
      ...http,
      context: {
        db,
        favorites,
        build: config.build,
        hotkeys,
        automations,
        automationRunner,
        automationSources,
        traces,
        extensions,
        remoteApps: host.remoteApps,
        appActions: host.appActions,
        appConversations:
          config.sharedApp === undefined ||
          config.sharedApp.demo === true ||
          host.appActions === undefined
            ? undefined
            : new AppConversations({
                llmApi: host.llmApi,
                actions: host.appActions,
                directory: path.join(config.appDataDir, "app-conversations"),
              }),
        workspace,
        search,
        uploads,
        threads,
        maintenance,
        connections: connectionService,
        toolRuntime,
        logger: host.logger,
        testApiEnabled: config.testApiEnabled === true,
      },
      corsOrigins: config.corsOrigins,
      gateway: config.gateway,
      desktopOrigin: config.desktopOrigin,
    });
    cleanup.defer(async () => await requests.close());
    await extensions.reload();
    const scheduled = await automationScheduler.start();
    if (scheduled instanceof Error) return scheduled;
    cleanup.move();
    return new WorkspaceServer({
      idleReporter,
      filesystem,
      db,
      threadRepo,
      workspace,
      threads,
      uploads,
      automations,
      automationRunner,
      automationScheduler,
      automationSync,
      toolRuntime,
      web,
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
    // Routine runs record their interruption before their threads close.
    await this.automationScheduler.stop();
    await this.automationSync?.close();
    await this.automationRunner.stop();
    await this.automations.close();
    const threadsClosed = await this.threads.shutdown();
    this.uploads.close();
    await this.traces.close();
    await this.browsers?.shutdown();
    await this.extensions.stop();
    const toolsClosed = await this.toolRuntime.close();
    const webClosed = await this.web.close();
    const repoClosed = await this.threadRepo.close();
    const databaseClosed = await this.db.close();
    const httpClosed = await closeHaloHttp(this.http);
    this.workspace.close();
    const filesystemClosed = await this.filesystem.close();

    if (httpClosed instanceof Error) return httpClosed;
    if (threadsClosed instanceof Error) return threadsClosed;
    if (toolsClosed instanceof Error) return toolsClosed;
    if (webClosed instanceof Error) return webClosed;
    if (repoClosed instanceof Error) return repoClosed;
    if (databaseClosed instanceof Error) return databaseClosed;
    if (filesystemClosed instanceof Error) return filesystemClosed;
  }
}
