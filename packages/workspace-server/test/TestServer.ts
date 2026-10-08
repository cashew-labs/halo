import {
  WorkspaceServer,
  type WorkspaceServerOptions,
} from "@get-halo/workspace-server";
import { createHaloClient, type HaloClient } from "@get-halo/client";
import type { TestArtifacts } from "./TestArtifacts.js";

type RunningServer = {
  server: WorkspaceServer;
  rpc: HaloClient;
  rendererRpc: HaloClient;
};

export class TestServer {
  // Tracks the running host and its fixture-owned clients.
  private current: RunningServer | undefined;
  // Reuses the product port when a scenario restarts its host.
  private listenPort = 0;

  readonly workspaceRoot: string;
  private readonly artifacts: TestArtifacts;
  private readonly llmApi: WorkspaceServerOptions["host"]["llmApi"];
  private readonly agentCapabilities: WorkspaceServerOptions["host"]["agentCapabilities"];
  private readonly testApiEnabled: boolean;
  private readonly traceWorkspaceId: WorkspaceServerOptions["config"]["traceWorkspaceId"];
  private readonly traceUploader: WorkspaceServerOptions["host"]["traceUploader"];
  private readonly remoteConnections: WorkspaceServerOptions["host"]["remoteConnections"];
  private readonly remoteIntegrationTools: WorkspaceServerOptions["host"]["remoteIntegrationTools"];
  private readonly gateway: WorkspaceServerOptions["config"]["gateway"];

  constructor(ctx: {
    artifacts: TestArtifacts;
    workspaceRoot: string;
    llmApi: WorkspaceServerOptions["host"]["llmApi"];
    agentCapabilities?: WorkspaceServerOptions["host"]["agentCapabilities"];
    testApiEnabled?: boolean;
    traceUploader?: WorkspaceServerOptions["host"]["traceUploader"];
    remoteConnections?: WorkspaceServerOptions["host"]["remoteConnections"];
    remoteIntegrationTools?: WorkspaceServerOptions["host"]["remoteIntegrationTools"];
    traceWorkspaceId?: string;
    gateway?: WorkspaceServerOptions["config"]["gateway"];
  }) {
    const {
      artifacts,
      workspaceRoot,
      llmApi,
      testApiEnabled,
      traceUploader,
      traceWorkspaceId,
      gateway,
    } = ctx;
    this.artifacts = artifacts;
    this.workspaceRoot = workspaceRoot;
    this.llmApi = llmApi;
    this.agentCapabilities = ctx.agentCapabilities;
    this.testApiEnabled = testApiEnabled === undefined ? false : testApiEnabled;
    this.traceUploader = traceUploader;
    this.remoteConnections = ctx.remoteConnections;
    this.remoteIntegrationTools = ctx.remoteIntegrationTools;
    this.traceWorkspaceId = traceWorkspaceId;
    this.gateway = gateway;
  }

  get harness() {
    return this.artifacts.harness;
  }

  get transport() {
    const connection = this.running.server.ready.connections.cli;
    return {
      origin: `http://127.0.0.1:${connection.port}`,
      path: "/rpc" as const,
      headers: { authorization: `Bearer ${connection.token}` },
    };
  }

  get rpc() {
    return this.running.rpc;
  }

  get rendererRpc() {
    return this.running.rendererRpc;
  }

  async promptAndWait(...args: Parameters<HaloClient["thread"]["prompt"]>) {
    const [input, options] = args;
    const accepted = await this.rpc.thread.prompt(input, options);
    return await this.rpc.thread.wait(
      { sessionId: input.sessionId, submissionId: accepted.submissionId },
      options,
    );
  }

  async start() {
    if (this.current !== undefined) {
      throw new Error(
        "The server is already running. Call server.stop() before starting it again.",
      );
    }
    const server = await WorkspaceServer.start({
      config: {
        environment: "local",
        workspaceRoot: this.workspaceRoot,
        appDataDir: this.artifacts.paths.userData,
        appVersion: "0.0.0-test",
        ownerUserId: "server-test-user",
        host: "127.0.0.1",
        port: this.listenPort,
        corsOrigins: [],
        testApiEnabled: this.testApiEnabled,
        traceWorkspaceId: this.traceWorkspaceId,
        gateway: this.gateway,
        extensionRuntime: {
          executable: process.execPath,
          electronRunAsNode: false,
        },
      },
      host: {
        llmApi: this.llmApi,
        remoteConnections: this.remoteConnections,
        remoteIntegrationTools: this.remoteIntegrationTools,
        agentCapabilities: this.agentCapabilities,
        traceUploader: this.traceUploader,
        logger: this.artifacts.logger,
      },
    });
    if (server instanceof Error) throw server;
    const { connections } = server.ready;
    this.listenPort = connections.cli.port;
    this.current = {
      server,
      rpc: createHaloClient({
        transport: {
          origin: `http://127.0.0.1:${connections.cli.port}`,
          path: "/rpc",
          headers: { authorization: `Bearer ${connections.cli.token}` },
        },
      }),
      rendererRpc: createHaloClient({
        transport: {
          origin: `http://127.0.0.1:${connections.renderer.port}`,
          path: "/rpc",
          headers: {
            authorization: `Bearer ${connections.renderer.token}`,
          },
        },
      }),
    };
  }

  async stop() {
    const current = this.current;
    if (current === undefined) return;
    this.current = undefined;
    const closed = await current.server.close();
    if (closed instanceof Error) throw closed;
  }

  private get running(): RunningServer {
    if (this.current === undefined) {
      throw new Error(
        "The server is stopped. Call server.start() before using its clients.",
      );
    }
    return this.current;
  }
}
