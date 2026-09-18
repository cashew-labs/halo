import {
  FileCredentialVault,
  WorkspaceServer,
  type WorkspaceServerOptions,
} from "@get-halo/workspace-server";
import { createHaloClient, type HaloClient } from "@get-halo/client";
import path from "node:path";
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
  private readonly testApiEnabled: boolean;
  private readonly traceWorkspaceId: WorkspaceServerOptions["config"]["traceWorkspaceId"];
  private readonly traceUploader: WorkspaceServerOptions["host"]["traceUploader"];

  constructor(ctx: {
    artifacts: TestArtifacts;
    workspaceRoot: string;
    llmApi: WorkspaceServerOptions["host"]["llmApi"];
    testApiEnabled?: boolean;
    traceUploader?: WorkspaceServerOptions["host"]["traceUploader"];
    traceWorkspaceId?: string;
  }) {
    const {
      artifacts,
      workspaceRoot,
      llmApi,
      testApiEnabled,
      traceUploader,
      traceWorkspaceId,
    } = ctx;
    this.artifacts = artifacts;
    this.workspaceRoot = workspaceRoot;
    this.llmApi = llmApi;
    this.testApiEnabled = testApiEnabled === undefined ? false : testApiEnabled;
    this.traceUploader = traceUploader;
    this.traceWorkspaceId = traceWorkspaceId;
  }

  get harness() {
    return this.artifacts.harness;
  }

  get rpc() {
    return this.running.rpc;
  }

  get rendererRpc() {
    return this.running.rendererRpc;
  }

  get rendererConnection() {
    return this.running.server.ready.connections.renderer;
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
        extensionRuntime: {
          executable: process.execPath,
          electronRunAsNode: false,
        },
      },
      host: {
        llmApi: this.llmApi,
        traceUploader: this.traceUploader,
        logger: this.artifacts.logger,
        createCredentialVault: ({ filesystem, workspaceRoot }) =>
          new FileCredentialVault({
            filesystem,
            directory: path.join(
              workspaceRoot,
              ".halo",
              "executor",
              "credentials",
            ),
          }),
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
