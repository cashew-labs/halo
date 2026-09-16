import {
  WorkspaceServer,
  type WorkspaceServerOptions,
} from "@get-halo/workspace-server";
import { createHaloClient, type HaloClient } from "@get-halo/client";
import path from "node:path";
import { FileCredentialVault } from "../src/agent/runtime/FileCredentialVault.js";
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
  private readonly llmApi: WorkspaceServerOptions["llmApi"];

  constructor(ctx: {
    artifacts: TestArtifacts;
    workspaceRoot: string;
    llmApi: WorkspaceServerOptions["llmApi"];
  }) {
    const { artifacts, workspaceRoot, llmApi } = ctx;
    this.artifacts = artifacts;
    this.workspaceRoot = workspaceRoot;
    this.llmApi = llmApi;
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

  async start() {
    if (this.current !== undefined) {
      throw new Error(
        "The server is already running. Call server.stop() before starting it again.",
      );
    }
    const server = await WorkspaceServer.start({
      environment: "local",
      llmApi: this.llmApi,
      workspaceRoot: this.workspaceRoot,
      appDataDir: this.artifacts.paths.userData,
      appVersion: "0.0.0-test",
      ownerUserId: Promise.resolve("server-test-user"),
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
      host: "127.0.0.1",
      port: this.listenPort,
      corsOrigins: [],
      testApiEnabled: true,
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
