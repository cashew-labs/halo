import { join } from "node:path";
import type { ControlPlaneConfig } from "@get-halo/config/controlPlane";
import * as errore from "errore";
import { AuthService } from "../auth/AuthService.js";
import {
  closeControlPlaneHttp,
  type ListeningControlPlaneHttp,
  listenControlPlaneHttp,
  serveControlPlaneHttp,
  type ServingControlPlaneHttp,
} from "./controlPlaneHttp.js";
import { DatabaseService, type DatabaseConfig } from "../DatabaseService.js";
import { WorkspaceService } from "../workspace/WorkspaceService.js";
import type { WorkspaceProviderApi } from "../workspace/provider/WorkspaceProviderApi.js";

import { TraceIngestion } from "../traces/TraceIngestion.js";
import type { TraceCloud } from "../traces/TraceCloud.js";
import { CredentialService } from "../credentials/CredentialService.js";
import { IntegrationService } from "../integrations/IntegrationService.js";

const loopbackHost = "127.0.0.1";
const cloudRunHost = "0.0.0.0";

export class ControlPlane {
  private readonly db: DatabaseService;
  private readonly http: ListeningControlPlaneHttp;
  private readonly publicOrigin: string;
  // Owns active requests that upgraded beyond the HTTP server lifecycle.
  private readonly requests: ServingControlPlaneHttp;
  readonly integrations: IntegrationService | undefined;

  private constructor(ctx: {
    db: DatabaseService;
    http: ListeningControlPlaneHttp;
    publicOrigin: string;
    requests: ServingControlPlaneHttp;
    integrations: IntegrationService | undefined;
  }) {
    this.db = ctx.db;
    this.http = ctx.http;
    this.publicOrigin = ctx.publicOrigin;
    this.requests = ctx.requests;
    this.integrations = ctx.integrations;
  }

  get origin() {
    return this.publicOrigin;
  }

  static async start(ctx: {
    config: ControlPlaneConfig;
    webRoot: string;
    workspaceProvider: WorkspaceProviderApi;
    build?: { version: string; revision: string };
    traceCloud?: TraceCloud;
    inferenceApiKey?: string;
    workspaceIdleTimeoutMs?: number;
    integrationEncryptionKey?: Buffer;
    integrationHttpClientLayer?: Parameters<
      typeof IntegrationService.start
    >[0]["httpClientLayer"];
  }) {
    const { config, webRoot } = ctx;
    await using cleanup = new errore.AsyncDisposableStack();

    const http = await listenControlPlaneHttp(
      controlPlaneHost(config),
      config.port,
    );
    if (http instanceof Error) return http;

    cleanup.defer(async () => {
      const closed = await closeControlPlaneHttp(http.server);
      if (closed instanceof Error) console.error(closed);
    });

    const publicOrigin =
      config.deployment === "local" ? http.origin : config.origin;

    const db = await DatabaseService.start(databaseConfig(config));
    if (db instanceof Error) return db;

    cleanup.defer(async () => {
      const closed = await db.close();
      if (closed instanceof Error) console.error(closed);
    });

    const auth = await AuthService.start({
      db,
      origin: publicOrigin,
      secret: config.auth.secret,
      googleClientId: config.auth.googleClientId,
      googleClientSecret: config.auth.googleClientSecret,
    });
    if (auth instanceof Error) return auth;

    const workspace = await WorkspaceService.start({
      db,
      provider: ctx.workspaceProvider,
      auth,
      origin: publicOrigin,
      idleTimeoutMs: ctx.workspaceIdleTimeoutMs,
    });
    if (workspace instanceof Error) return workspace;

    const credentials =
      ctx.integrationEncryptionKey === undefined
        ? undefined
        : await CredentialService.start({
            db,
            encryptionKey: ctx.integrationEncryptionKey,
          });
    if (credentials instanceof Error) return credentials;
    const integrations =
      credentials === undefined
        ? undefined
        : await IntegrationService.start({
            db,
            credentials,
            httpClientLayer: ctx.integrationHttpClientLayer,
          });
    if (integrations instanceof Error) return integrations;
    cleanup.defer(async () => {
      const closed = await integrations?.close();
      if (closed instanceof Error) console.error(closed);
    });

    const requests = serveControlPlaneHttp({
      server: http.server,
      auth,
      publicOrigin,
      workspace,
      webRoot,
      build: ctx.build,
      inferenceApiKey: ctx.inferenceApiKey,
      traces:
        ctx.traceCloud === undefined
          ? undefined
          : new TraceIngestion({
              cloud: ctx.traceCloud,
              workspace,
            }),
    });
    cleanup.move();

    return new ControlPlane({
      db,
      http,
      publicOrigin,
      requests,
      integrations,
    });
  }

  async close() {
    this.requests.close();
    const httpClosed = await closeControlPlaneHttp(this.http.server);
    const integrationsClosed = await this.integrations?.close();
    const databaseClosed = await this.db.close();

    if (httpClosed instanceof Error) return httpClosed;
    if (integrationsClosed instanceof Error) return integrationsClosed;
    if (databaseClosed instanceof Error) return databaseClosed;
  }
}

function controlPlaneHost(config: ControlPlaneConfig) {
  return config.deployment === "local" ? loopbackHost : cloudRunHost;
}

function databaseConfig(config: ControlPlaneConfig): DatabaseConfig {
  if (config.deployment === "local") {
    return {
      type: "sqlite",
      path: join(config.appDataDir, "control-plane.db"),
    };
  }

  return {
    type: "postgres",
    connectionString: config.databaseUrl,
  };
}
