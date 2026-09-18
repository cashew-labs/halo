import { join } from "node:path";
import type { ControlPlaneConfig } from "@get-halo/config/controlPlane";
import * as errore from "errore";
import { AuthService } from "../auth/AuthService.js";
import {
  closeControlPlaneHttp,
  type ListeningControlPlaneHttp,
  listenControlPlaneHttp,
  serveControlPlaneHttp,
} from "./controlPlaneHttp.js";
import { DatabaseService, type DatabaseConfig } from "../DatabaseService.js";
import { WorkspaceService } from "../workspace/WorkspaceService.js";

import { TraceIngestion } from "../traces/TraceIngestion.js";
import type { TraceCloud } from "../traces/TraceCloud.js";

const loopbackHost = "127.0.0.1";
const cloudRunHost = "0.0.0.0";

export class ControlPlane {
  private readonly db: DatabaseService;
  private readonly http: ListeningControlPlaneHttp;
  private readonly publicOrigin: string;

  private constructor(ctx: {
    db: DatabaseService;
    http: ListeningControlPlaneHttp;
    publicOrigin: string;
  }) {
    this.db = ctx.db;
    this.http = ctx.http;
    this.publicOrigin = ctx.publicOrigin;
  }

  get origin() {
    return this.publicOrigin;
  }

  static async start(ctx: {
    config: ControlPlaneConfig;
    webRoot: string;
    traceCloud?: TraceCloud;
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
      config:
        config.deployment === "local"
          ? { deployment: "local", appDataDir: config.appDataDir }
          : config.workspace,
    });
    if (workspace instanceof Error) return workspace;

    serveControlPlaneHttp({
      server: http.server,
      auth,
      workspace,
      webRoot,
      traces:
        ctx.traceCloud === undefined
          ? undefined
          : new TraceIngestion({
              cloud: ctx.traceCloud,
              workspace,
              origin: publicOrigin,
            }),
    });
    cleanup.move();

    return new ControlPlane({
      db,
      http,
      publicOrigin,
    });
  }

  async close() {
    const httpClosed = await closeControlPlaneHttp(this.http.server);
    const databaseClosed = await this.db.close();

    if (httpClosed instanceof Error) return httpClosed;
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
