import type { OAuth2Client } from "google-auth-library";
import { GmailService } from "../automations/GmailService.js";
import { GmailPushReceiver } from "../automations/gmailHttp.js";
import { WebhookService } from "../automations/WebhookService.js";
import { AutomationStore } from "../automations/AutomationStore.js";
import { AutomationCoordinator } from "../automations/AutomationCoordinator.js";
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
import { RoutineCoordinator } from "../workspace/RoutineCoordinator.js";
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
  private readonly routines: RoutineCoordinator;
  private readonly gmail: GmailService;
  private readonly automationCoordinator: AutomationCoordinator;

  private constructor(ctx: {
    db: DatabaseService;
    http: ListeningControlPlaneHttp;
    publicOrigin: string;
    requests: ServingControlPlaneHttp;
    integrations: IntegrationService | undefined;
    routines: RoutineCoordinator;
    gmail: GmailService;
    automationCoordinator: AutomationCoordinator;
  }) {
    this.db = ctx.db;
    this.http = ctx.http;
    this.publicOrigin = ctx.publicOrigin;
    this.requests = ctx.requests;
    this.integrations = ctx.integrations;
    this.routines = ctx.routines;
    this.gmail = ctx.gmail;
    this.automationCoordinator = ctx.automationCoordinator;
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
    getOpenAPISpec?: (url: string) => Promise<string | Error>;
    allowLocalIntegrationUrls?: boolean;
    gmailPushAuth?: OAuth2Client;
    gmailApiOrigin?: string;
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
            getOpenAPISpec: ctx.getOpenAPISpec,
            publicOrigin,
            gmailApiOrigin:
              config.deployment === "local" ? ctx.gmailApiOrigin : undefined,
            allowLocalUrls:
              config.deployment === "local" &&
              ctx.allowLocalIntegrationUrls === true,
            firstPartyOAuthClients: [
              {
                name: "google",
                authorizationUrl:
                  "https://accounts.google.com/o/oauth2/v2/auth",
                tokenUrl: "https://oauth2.googleapis.com/token",
                clientId: config.auth.googleClientId,
                clientSecret: config.auth.googleClientSecret,
              },
            ],
          });
    if (integrations instanceof Error) return integrations;
    cleanup.defer(async () => {
      const closed = await integrations?.close();
      if (closed instanceof Error) console.error(closed);
    });
    const routines = await RoutineCoordinator.start({ db, workspace });
    if (routines instanceof Error) return routines;
    cleanup.defer(async () => await routines.close());

    const automationStore = new AutomationStore({ db });
    const initializedAutomations = await automationStore.initialize();
    if (initializedAutomations instanceof Error) return initializedAutomations;
    const webhooks = new WebhookService({
      store: automationStore,
      credentials,
      origin: publicOrigin,
    });
    const initializedWebhooks = await webhooks.initialize();
    if (initializedWebhooks instanceof Error) return initializedWebhooks;
    const gmail = new GmailService({
      automations: automationStore,
      integrations,
      configuration: config.gmail,
    });
    const initializedGmail = await gmail.start();
    if (initializedGmail instanceof Error) return initializedGmail;
    cleanup.defer(async () => await gmail.close());
    const gmailPush = new GmailPushReceiver({ gmail, auth: ctx.gmailPushAuth });
    const automationCoordinator = new AutomationCoordinator({
      store: automationStore,
      workspace,
    });
    automationCoordinator.start();
    cleanup.defer(async () => await automationCoordinator.close());

    const requests = serveControlPlaneHttp({
      server: http.server,
      auth,
      publicOrigin,
      workspace,
      integrations,
      routines,
      automationStore,
      webhooks,
      gmail,
      gmailPush,
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
      routines,
      gmail,
      automationCoordinator,
    });
  }

  async close() {
    this.requests.close();
    await this.routines.close();
    await this.gmail.close();
    await this.automationCoordinator.close();
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
