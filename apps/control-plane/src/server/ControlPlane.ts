import {
  WorkspaceUpdates,
  type WorkspaceUpdateTarget,
} from "../workspace/WorkspaceUpdates.js";
import { MarketingLinks } from "../marketing/MarketingLinks.js";
import type { Logger, LoggerApi } from "@get-halo/logger";
import type { OAuth2Client } from "google-auth-library";
import { GmailService } from "../automations/GmailService.js";
import { GmailPushReceiver } from "../automations/gmailHttp.js";
import { WebhookService } from "../automations/WebhookService.js";
import { AutomationStore } from "../automations/AutomationStore.js";
import { AutomationCoordinator } from "../automations/AutomationCoordinator.js";
import { join } from "node:path";
import {
  readControlPlaneSecret,
  type ControlPlaneConfig,
} from "@get-halo/config/controlPlane";
import * as errore from "errore";
import { AuthService } from "../auth/AuthService.js";
import { SignInAllowlist } from "../auth/SignInAllowlist.js";
import {
  closeControlPlaneHttp,
  type ListeningControlPlaneHttp,
  listenControlPlaneHttp,
  serveControlPlaneHttp,
  type ServingControlPlaneHttp,
} from "./controlPlaneHttp.js";
import { DatabaseService, type DatabaseConfig } from "../DatabaseService.js";
import { WorkspaceService } from "../workspace/WorkspaceService.js";
import { AutomationScheduleCoordinator } from "../workspace/AutomationScheduleCoordinator.js";
import type { WorkspaceProviderApi } from "../workspace/provider/WorkspaceProviderApi.js";

import { TraceIngestion } from "../traces/TraceIngestion.js";
import type { WorkspaceInference } from "../inference/workspaceInference.js";
import type { TraceCloud } from "../traces/TraceCloud.js";
import { CredentialService } from "../credentials/CredentialService.js";
import { IntegrationService } from "../integrations/IntegrationService.js";
import { AppStore } from "../apps/AppStore.js";
import { AppService } from "../apps/AppService.js";
import { AppCredentials } from "../apps/AppCredentials.js";
import { AppGateway } from "../apps/AppGateway.js";
import { WorkspaceAuthorization } from "../workspace/proxy.js";

const loopbackHost = "127.0.0.1";
const cloudRunHost = "0.0.0.0";

export class ControlPlane {
  private readonly db: DatabaseService;
  private readonly http: ListeningControlPlaneHttp;
  private readonly publicOrigin: string;
  // Owns active requests that upgraded beyond the HTTP server lifecycle.
  private readonly requests: ServingControlPlaneHttp;
  readonly integrations: IntegrationService | undefined;
  private readonly automationSchedules: AutomationScheduleCoordinator;
  private readonly gmail: GmailService;
  private readonly automationCoordinator: AutomationCoordinator;

  private constructor(ctx: {
    db: DatabaseService;
    http: ListeningControlPlaneHttp;
    publicOrigin: string;
    requests: ServingControlPlaneHttp;
    integrations: IntegrationService | undefined;
    automationSchedules: AutomationScheduleCoordinator;
    gmail: GmailService;
    automationCoordinator: AutomationCoordinator;
  }) {
    this.db = ctx.db;
    this.http = ctx.http;
    this.publicOrigin = ctx.publicOrigin;
    this.requests = ctx.requests;
    this.integrations = ctx.integrations;
    this.automationSchedules = ctx.automationSchedules;
    this.gmail = ctx.gmail;
    this.automationCoordinator = ctx.automationCoordinator;
  }

  get origin() {
    return this.publicOrigin;
  }

  static async start(ctx: {
    logger: Logger;
    config: ControlPlaneConfig;
    githubOAuthOrigin?: string;
    webRoot: string;
    workspaceProvider: WorkspaceProviderApi;
    build?: { version: string; revision: string };
    traceCloud?: TraceCloud;
    inference?: WorkspaceInference;
    workspaceIdleTimeoutMs?: number;
    workspaceUpdateTarget?: WorkspaceUpdateTarget;
    workspaceUpdateIdleMs?: number;
    workspaceUpdateToken?: () => Promise<string | Error>;
    integrationEncryptionKey?: Buffer;
    getOpenAPISpec?: (url: string) => Promise<string | Error>;
    allowLocalIntegrationUrls?: boolean;
    gmailPushAuth?: OAuth2Client;
    gmailApiOrigin?: string;
    googleRevokeUrl?: string;
    appReadyTimeoutMs?: number;
    developmentPreview?: boolean;
  }) {
    const { config, webRoot, logger } = ctx;
    await using cleanup = new errore.AsyncDisposableStack();

    const http = await listenControlPlaneHttp(
      controlPlaneHost(config),
      config.port,
    );
    if (http instanceof Error) return http;

    cleanup.defer(async () => {
      const closed = await closeControlPlaneHttp(http.server);
      if (closed instanceof Error)
        logger.error({ event: "http-close-failed", errorType: closed.name });
    });

    const publicOrigin = config.origin ?? http.origin;

    const db = await DatabaseService.start({
      config: databaseConfig(config),
      logger: logger.scope("database"),
    });
    if (db instanceof Error) return db;

    cleanup.defer(async () => {
      const closed = await db.close();
      if (closed instanceof Error)
        logger.error({
          event: "database-close-failed",
          errorType: closed.name,
        });
    });

    const auth = await AuthService.start({
      logger: logger.scope("auth"),
      db,
      origin: publicOrigin,
      secret: config.auth.secret,
      googleClientId: config.auth.googleClientId,
      googleClientSecret: config.auth.googleClientSecret,
      previewLogin:
        config.deployment === "local" && ctx.developmentPreview === true,
      signInAllowlist: signInAllowlist(
        config.auth.signInAllowlistSecretId,
        logger.scope("sign-in-allowlist"),
      ),
      stagingTesters: signInAllowlist(
        config.auth.stagingTestersSecretId,
        logger.scope("staging-testers"),
      ),
    });
    if (auth instanceof Error) return auth;

    const workspace = await WorkspaceService.start({
      logger: logger.scope("workspace"),
      db,
      provider: ctx.workspaceProvider,
      auth,
      origin: publicOrigin,
      idleTimeoutMs: ctx.workspaceIdleTimeoutMs,
    });
    if (workspace instanceof Error) return workspace;
    const workspaceUpdates = new WorkspaceUpdates({
      database: db.appDatabase,
      workspace,
      target: ctx.workspaceUpdateTarget,
      idleMs: ctx.workspaceUpdateIdleMs,
      registryToken: ctx.workspaceUpdateToken,
    });
    const updatesStarted = await workspaceUpdates.initialize();
    if (updatesStarted instanceof Error) return updatesStarted;

    const credentials =
      ctx.integrationEncryptionKey === undefined
        ? undefined
        : await CredentialService.start({
            db,
            encryptionKey: ctx.integrationEncryptionKey,
          });
    if (credentials instanceof Error) return credentials;
    const githubOAuthOrigin =
      config.deployment === "local"
        ? (ctx.githubOAuthOrigin ?? "https://github.com") // coverage-exempt: non-local startup requires Cloud Run/PostgreSQL; local default and override are asserted through OAuth RPC tests
        : "https://github.com";
    const integrations =
      credentials === undefined
        ? undefined
        : await IntegrationService.start({
            logger: logger.scope("integrations"),
            db,
            credentials,
            getOpenAPISpec: ctx.getOpenAPISpec,
            publicOrigin,
            gmailApiOrigin:
              config.deployment === "local" ? ctx.gmailApiOrigin : undefined,
            googleRevokeUrl:
              config.deployment === "local" ? ctx.googleRevokeUrl : undefined,
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
              ...(config.github === undefined
                ? []
                : [
                    {
                      name: "github",
                      authorizationUrl: `${githubOAuthOrigin}/login/oauth/authorize`,
                      tokenUrl: `${githubOAuthOrigin}/login/oauth/access_token`,
                      clientId: config.github.clientId,
                      clientSecret: config.github.clientSecret,
                      authorizationScopes: [],
                      allowedScopes: [],
                    },
                  ]),
            ],
          });
    if (integrations instanceof Error) return integrations;
    cleanup.defer(async () => {
      const closed = await integrations?.close();
      if (closed instanceof Error)
        logger.error({
          event: "integrations-close-failed",
          errorType: closed.name,
        });
    });
    const automationSchedules = await AutomationScheduleCoordinator.start({
      logger: logger.scope("automation-schedules"),
      db,
      workspace,
    });
    if (automationSchedules instanceof Error) return automationSchedules;
    cleanup.defer(async () => await automationSchedules.close());

    const automationStore = new AutomationStore({
      db,
      logger: logger.scope("automation-store"),
    });
    const initializedAutomations = await automationStore.initialize();
    if (initializedAutomations instanceof Error) return initializedAutomations;
    const webhooks = new WebhookService({
      logger: logger.scope("webhooks"),
      store: automationStore,
      credentials,
      origin: publicOrigin,
    });
    const initializedWebhooks = await webhooks.initialize();
    if (initializedWebhooks instanceof Error) return initializedWebhooks;
    const gmail = new GmailService({
      logger: logger.scope("gmail"),
      automations: automationStore,
      integrations,
      configuration: config.gmail,
    });
    const initializedGmail = await gmail.start();
    if (initializedGmail instanceof Error) return initializedGmail;
    cleanup.defer(async () => await gmail.close());
    const gmailPush = new GmailPushReceiver({ gmail, auth: ctx.gmailPushAuth });
    const automationCoordinator = new AutomationCoordinator({
      logger: logger.scope("automation-delivery"),
      store: automationStore,
      workspace,
    });
    automationCoordinator.start();
    cleanup.defer(async () => await automationCoordinator.close());

    const appStore = new AppStore({ db });
    const initializedApps = await appStore.initialize();
    if (initializedApps instanceof Error) return initializedApps;
    const marketing = new MarketingLinks({
      database: db.appDatabase,
      adminUserIds: config.marketingAdminUserIds ?? [],
    });
    const initializedMarketing = await marketing.initialize();
    if (initializedMarketing instanceof Error) return initializedMarketing; // coverage-exempt: Database schema creation failure at startup; service-level database errors are tested through a closed real connection.
    const authorization = new WorkspaceAuthorization();
    const apps = new AppService({
      logger: logger.scope("apps"),
      store: appStore,
      credentials: new AppCredentials({ secret: config.auth.secret }),
      workspace,
      provider: ctx.workspaceProvider,
      authorization,
      integrations,
      publicOrigin,
      readyTimeoutMs: ctx.appReadyTimeoutMs,
    });

    const requests = serveControlPlaneHttp({
      logger: logger.scope("http"),
      server: http.server,
      auth,
      authorization,
      apps,
      appStore,
      appGateway: new AppGateway({
        store: appStore,
        provider: ctx.workspaceProvider,
        authorization,
        publicOrigin,
      }),
      publicOrigin,
      workspace,
      workspaceUpdates,
      integrations,
      automationSchedules,
      automationStore,
      webhooks,
      gmail,
      gmailPush,
      webRoot,
      build: ctx.build,
      googleAnalyticsMeasurementId: config.googleAnalyticsMeasurementId,
      environment: config.environment,
      marketing,
      marketingHostname: config.marketingHostname,
      marketingHomepageOrigin: config.marketingHomepageOrigin,
      inference: ctx.inference,
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
      automationSchedules,
      gmail,
      automationCoordinator,
    });
  }

  async close() {
    this.requests.close();
    await this.automationSchedules.close();
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

function signInAllowlist(secretId: string | undefined, logger: LoggerApi) {
  if (secretId === undefined) return undefined;
  // A new secret version takes effect within a minute, without a redeploy.
  return new SignInAllowlist({
    logger,
    read: async () => await readControlPlaneSecret(secretId),
    refreshMs: 60_000,
  });
}
