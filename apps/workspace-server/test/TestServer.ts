import { HaloServer, type HaloServerOptions } from "@get-halo/workspace-server";
import { createHaloClient, type HaloClient } from "@get-halo/client";
import path from "node:path";
import { FileCredentialVault } from "../src/agent/runtime/FileCredentialVault.js";
import type { TestArtifacts } from "./TestArtifacts.js";

type RunningServer = {
  halo: HaloServer;
  rpc: HaloClient;
  rendererRpc: HaloClient;
};

export class TestServer {
  private current: RunningServer | undefined;
  private listenPort = 0;

  constructor(
    private readonly options: {
      artifacts: TestArtifacts;
      workspaceRoot: string;
      llmApi: HaloServerOptions["llmApi"];
      traceUploader?: HaloServerOptions["traceUploader"];
      traceWorkspaceId?: string;
    },
  ) {}

  get workspaceRoot() {
    return this.options.workspaceRoot;
  }

  get harness() {
    return this.options.artifacts.harness;
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
    const halo = await HaloServer.start({
      environment: "local",
      llmApi: this.options.llmApi,
      traceUploader: this.options.traceUploader,
      traceWorkspaceId: this.options.traceWorkspaceId,
      workspaceRoot: this.workspaceRoot,
      appDataDir: this.options.artifacts.paths.userData,
      appVersion: "0.0.0-test",
      ownerUserId: Promise.resolve("server-test-user"),
      logger: this.options.artifacts.logger,
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
    });
    if (halo instanceof Error) throw halo;
    this.listenPort = halo.connections.cli.port;
    this.current = {
      halo,
      rpc: createHaloClient({
        transport: {
          origin: `http://127.0.0.1:${halo.connections.cli.port}`,
          path: "/rpc",
          headers: { authorization: `Bearer ${halo.connections.cli.token}` },
        },
      }),
      rendererRpc: createHaloClient({
        transport: {
          origin: `http://127.0.0.1:${halo.connections.renderer.port}`,
          path: "/rpc",
          headers: {
            authorization: `Bearer ${halo.connections.renderer.token}`,
          },
        },
      }),
    };
  }

  async stop() {
    const current = this.current;
    if (current === undefined) return;
    this.current = undefined;
    const closed = await current.halo.close();
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
