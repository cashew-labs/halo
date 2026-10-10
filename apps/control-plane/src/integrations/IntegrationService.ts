import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import stream from "node:stream";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { mcpPlugin } from "@executor-js/plugin-mcp/core";
import { openApiPlugin } from "@executor-js/plugin-openapi/core";
import {
  googleCatalog,
  googleDiscoveryAdapter,
} from "@executor-js/plugin-openapi/providers/google";
import {
  createExecutor,
  definePlugin,
  ConnectionNotFoundError,
  CredentialResolutionError,
  ElicitationDeclinedError,
  ToolBlockedError,
  Effect,
  isToolResult,
  parseToolAddress,
  IntegrationSlug,
  AuthTemplateSlug,
  ConnectionName,
  OAuthClientSlug,
  OAuthState,
  Owner,
  ProviderItemId,
  ProviderKey,
  StorageError,
  Subject,
  Tenant,
  type CredentialProvider,
  type Executor,
  type ProviderEntry,
  type Tool,
  type Integration,
  type Connection,
  type FirstPartyOAuthClientConfig,
} from "@executor-js/sdk/core";
import type {
  ConnectionRevocation,
  IntegrationConnection,
  IntegrationInvocation,
  IntegrationJson,
  IntegrationTool,
  IntegrationToolSchema,
  IntegrationSetup,
  IntegrationSetupCatalogEntry,
} from "@get-halo/shared/controlPlaneContract";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as errore from "errore";
import type { CredentialService } from "../credentials/CredentialService.js";
import type { DatabaseService, DatabaseClient } from "../DatabaseService.js";
import { withAccountChoice } from "./accountChoice.js";
import { GmailApi } from "../automations/GmailApi.js";
import { createExecutorDatabase } from "./createExecutorDatabase.js";

// Executor 1.6 rewrites Meet's Discovery URL to a legacy endpoint returning 404.
const presets = googleCatalog.filter((preset) => preset.id !== "google-meet");
const maxRemoteResponseBytes = 64 * 1024 * 1024;
// Host-only: no agent tools. The receipt and connection metadata commit together.
// CredentialService remains a separate store; this is proof of a completed save,
// not a distributed transaction covering every possible provider failure.
const setupReceipts = definePlugin(() => ({
  id: "haloSetups" as const,
  storage: () => ({}),
  extension: (ctx) => ({
    get: (setupId: string) =>
      ctx.pluginStorage.getForOwner<IntegrationConnection>({
        collection: "completed",
        key: setupId,
        owner: Owner.make("user"),
      }),
    run: <A, E>(input: {
      setupId: string;
      operation: Effect.Effect<A, E>;
      connection: (value: A) => Connection | undefined;
    }) =>
      ctx.transaction(
        Effect.gen(function* () {
          const result = yield* input.operation;
          const connection = input.connection(result);
          if (connection !== undefined)
            yield* ctx.pluginStorage.put({
              collection: "completed",
              key: input.setupId,
              owner: Owner.make("user"),
              data: safeConnection(connection),
            });
          return result;
        }),
      ),
  }),
}));
type IntegrationPlugins = readonly [
  ReturnType<typeof openApiPlugin>,
  ReturnType<typeof mcpPlugin>,
  ReturnType<typeof setupReceipts>,
];
type IntegrationExecutor = Executor<IntegrationPlugins>;

class IntegrationServiceError extends errore.createTaggedError({
  name: "IntegrationServiceError",
  message: "Integration service failed: $detail",
}) {}

export class IntegrationToolNotFoundError extends errore.createTaggedError({
  name: "IntegrationToolNotFoundError",
  message: "Integration tool not found",
}) {}

export class IntegrationSetupError extends errore.createTaggedError({
  name: "IntegrationSetupError",
  message: "$detail",
}) {}

type SetupRow = {
  setup_id: string;
  user_id: string;
  data: string;
  status: IntegrationSetup["status"];
  expires_at: number;
  oauth_state?: string;
  owner_label?: string | null;
};

// A handoff link lets the browser that Halo opened act for the setup owner.
const handoffTtlMs = 2 * 60 * 1_000;

function secretHash(secret: string) {
  return crypto.createHash("sha256").update(secret).digest("base64url");
}

// Persist only identity/bindings, never credentials; reconnect is fixed at start.
type StoredSetup = IntegrationSetup & {
  reconnect?: {
    template: string;
    client?: string;
    clientOwner?: "user" | "org";
  };
};

export class IntegrationService {
  // Coalesce first-use initialization per user and drain all work before shutdown.
  private readonly executors = new Map<
    string,
    Promise<IntegrationExecutor | IntegrationServiceError>
  >();
  private readonly active = new Set<Promise<unknown>>();
  private readonly activeUsers = new Map<string, number>();
  private readonly initializing = new Set<string>();
  private closed = false;
  private readonly database: Exclude<
    Awaited<ReturnType<typeof createExecutorDatabase>>,
    Error
  >;
  private readonly credentials: CredentialService;
  private readonly plugins: IntegrationPlugins;
  private readonly setupDb: DatabaseClient;
  private readonly publicOrigin: string;
  private readonly firstPartyOAuthClients: readonly FirstPartyOAuthClientConfig[];
  private readonly allowLocalUrls: boolean;
  private readonly gmailTransport = new AsyncLocalStorage<boolean>();
  private readonly gmailApiOrigin: string | undefined;
  private readonly googleRevokeUrl: string;

  private constructor(ctx: {
    database: Exclude<
      Awaited<ReturnType<typeof createExecutorDatabase>>,
      Error
    >;
    credentials: CredentialService;
    getOpenAPISpec?: (url: string) => Promise<string | Error>;
    setupDb: DatabaseClient;
    publicOrigin: string;
    firstPartyOAuthClients?: readonly FirstPartyOAuthClientConfig[];
    allowLocalUrls?: boolean;
    gmailApiOrigin?: string;
    googleRevokeUrl?: string;
  }) {
    this.database = ctx.database;
    this.googleRevokeUrl = ctx.googleRevokeUrl ?? googleRevokeUrl;
    this.credentials = ctx.credentials;
    this.setupDb = ctx.setupDb;
    this.publicOrigin = ctx.publicOrigin;
    this.firstPartyOAuthClients = ctx.firstPartyOAuthClients ?? [];
    this.allowLocalUrls = ctx.allowLocalUrls ?? false;
    this.gmailApiOrigin = ctx.gmailApiOrigin;
    const getOpenAPISpec = ctx.getOpenAPISpec;
    // Only spec loading is overridden. Tool invocations keep Executor's normal HTTP client.
    const httpClientLayer =
      getOpenAPISpec === undefined
        ? undefined
        : FetchHttpClient.layer.pipe(
            Layer.provide(
              Layer.succeed(FetchHttpClient.Fetch, async (input) => {
                const spec = await getOpenAPISpec(
                  input instanceof Request ? input.url : String(input),
                );
                // Fetch reports failure by rejecting; adapt Halo's error value at this SDK boundary.
                if (spec instanceof Error) throw spec;
                return new Response(spec, {
                  headers: { "content-type": "application/json" },
                });
              }),
            ),
          );
    const mcpHttpClientLayer = this.safeHttpLayer(true);
    const mcp = mcpPlugin({ httpClientLayer: mcpHttpClientLayer });
    this.plugins = [
      openApiPlugin({
        presets,
        httpClientLayer: this.safeHttpLayer(),
        specFormats: [
          httpClientLayer === undefined
            ? googleDiscoveryAdapter
            : {
                ...googleDiscoveryAdapter,
                fetch: (input) =>
                  googleDiscoveryAdapter.fetch({ ...input, httpClientLayer }),
              },
        ],
      }),
      // Remote HTTP/SSE only: never spawn user-supplied processes in the control plane.
      {
        ...mcp,
        // Executor 1.6 ignores the plugin HTTP override during discovery only.
        resolveTools: (input) =>
          mcp.resolveTools!({ ...input, httpClientLayer: mcpHttpClientLayer }),
      },
      setupReceipts(),
    ];
  }

  static async start(ctx: {
    db: DatabaseService;
    credentials: CredentialService;
    getOpenAPISpec?: (url: string) => Promise<string | Error>;
    publicOrigin: string;
    firstPartyOAuthClients?: readonly FirstPartyOAuthClientConfig[];
    allowLocalUrls?: boolean;
    gmailApiOrigin?: string;
    googleRevokeUrl?: string;
  }) {
    const database = await createExecutorDatabase(ctx.db);
    if (database instanceof Error) return database;
    const service = new IntegrationService({
      database,
      credentials: ctx.credentials,
      getOpenAPISpec: ctx.getOpenAPISpec,
      setupDb: ctx.db.client,
      publicOrigin: ctx.publicOrigin,
      firstPartyOAuthClients: ctx.firstPartyOAuthClients,
      allowLocalUrls: ctx.allowLocalUrls,
      gmailApiOrigin: ctx.gmailApiOrigin,
      googleRevokeUrl: ctx.googleRevokeUrl,
    });
    const initialized = await service.sql(
      "CREATE TABLE IF NOT EXISTS halo_integration_setup (setup_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, integration TEXT NOT NULL, connection_name TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, expires_at BIGINT NOT NULL, oauth_state TEXT)",
    );
    if (initialized instanceof Error) return initialized;
    const indexed = await service.sql(
      "CREATE UNIQUE INDEX IF NOT EXISTS halo_integration_setup_state ON halo_integration_setup (oauth_state) WHERE oauth_state NOT IN ('submitting','consuming')",
    );
    if (indexed instanceof Error) return indexed;
    const names = await service.sql(
      "CREATE UNIQUE INDEX IF NOT EXISTS halo_integration_setup_active_name ON halo_integration_setup (user_id,integration,connection_name) WHERE status='authorizing'",
    );
    if (names instanceof Error) return names;
    const dropped = await service.sql(
      "DROP INDEX IF EXISTS halo_integration_setup_name",
    );
    if (dropped instanceof Error) return dropped;
    // Stores only hashes of the handoff and browser secrets.
    const browsers = await service.sql(
      "CREATE TABLE IF NOT EXISTS halo_integration_setup_browser (setup_id TEXT PRIMARY KEY, handoff_hash TEXT, handoff_expires_at BIGINT, browser_hash TEXT, owner_label TEXT)",
    );
    if (browsers instanceof Error) return browsers;
    return service;
  }

  private async sql(query: string, params: (string | number)[] = []) {
    const db = this.setupDb;
    if (db instanceof DatabaseSync)
      return errore.try({
        // SAFETY: Every row-returning query below selects the service-owned setup table.
        try: () =>
          db.prepare(query.replace(/\$\d+/g, "?")).all(...params) as SetupRow[],
        catch: (cause) =>
          new IntegrationServiceError({ detail: "persist setup", cause }),
      });
    return await db
      .query<SetupRow>(query, params)
      .then((result) => result.rows)
      .catch(
        (cause) =>
          new IntegrationServiceError({ detail: "persist setup", cause }),
      );
  }

  async catalog(userId: string) {
    return await this.withUser(userId, (executor) =>
      Effect.map(executor.integrations.list(), (integrations) =>
        integrations.map(setupCatalogEntry),
      ),
    );
  }

  async startSetup(ctx: {
    userId: string;
    integration: string;
    connectionName?: string;
  }) {
    const catalog = await this.catalog(ctx.userId);
    if (catalog instanceof Error) return catalog;
    const entry = catalog.find(
      (candidate) => candidate.integration === ctx.integration,
    );
    if (entry === undefined)
      return new IntegrationSetupError({ detail: "Integration not found" });
    const existing =
      ctx.connectionName === undefined
        ? undefined
        : await this.withUser(ctx.userId, (executor) =>
            executor.connections.get({
              owner: Owner.make("user"),
              integration: IntegrationSlug.make(ctx.integration),
              name: ConnectionName.make(ctx.connectionName!),
            }),
          );
    if (existing instanceof Error) return existing;
    const setupId = crypto.randomUUID();
    const setup: StoredSetup = {
      ...entry,
      reconnect:
        existing === null || existing === undefined
          ? undefined
          : {
              template: existing.template,
              client: existing.oauthClient ?? undefined,
              clientOwner: existing.oauthClientOwner ?? undefined,
            },
      setupId,
      connectionName:
        ctx.connectionName ??
        `connection${crypto.randomBytes(6).toString("hex")}`,
      status: "awaiting_credentials",
    };
    const saved = await this.sql(
      "INSERT INTO halo_integration_setup (setup_id,user_id,data,status,expires_at,integration,connection_name) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [
        setupId,
        ctx.userId,
        JSON.stringify(setup),
        setup.status,
        Date.now() + 15 * 60 * 1000,
        setup.integration,
        setup.connectionName,
      ],
    );
    if (saved instanceof Error) return saved;
    return { setupId, setupUrl: this.setupUrl(setupId) };
  }

  private setupUrl(setupId: string) {
    return `${this.publicOrigin}/integrations/setup/${encodeURIComponent(setupId)}`;
  }

  async setup(ctx: { userId: string; setupId: string }) {
    const setup = await this.readSetup(ctx);
    if (setup instanceof Error) return setup;
    const { reconnect: _reconnect, ownerLabel, ...stored } = setup;
    const publicSetup: IntegrationSetup =
      ownerLabel === undefined ? stored : { ...stored, owner: ownerLabel };
    if (setup.status === "ready") return publicSetup;
    const receipt = await this.withUser(ctx.userId, (executor) =>
      executor.haloSetups.get(ctx.setupId),
    );
    if (receipt instanceof Error) return receipt;
    if (receipt !== null) {
      const saved = await this.confirmSetup({
        ...ctx,
        setup,
        connection: receipt.data,
      });
      if (saved instanceof Error) console.warn(saved);
      return {
        ...publicSetup,
        connection: receipt.data,
        status:
          saved instanceof Error ? ("confirming" as const) : ("ready" as const),
      };
    }
    return publicSetup;
  }

  private async readSetup(ctx: { userId: string; setupId: string }) {
    const expired = await this.sql(
      "UPDATE halo_integration_setup SET status='expired', oauth_state=NULL WHERE setup_id=$1 AND user_id=$2 AND expires_at <= $3 AND status IN ('awaiting_credentials','authorizing') AND (oauth_state IS NULL OR oauth_state NOT IN ('submitting','consuming') OR expires_at <= $4) RETURNING *",
      [ctx.setupId, ctx.userId, Date.now(), Date.now() - 30_000],
    );
    if (expired instanceof Error) return expired;
    const rows = await this.sql(
      "SELECT s.*, b.owner_label FROM halo_integration_setup s LEFT JOIN halo_integration_setup_browser b ON b.setup_id=s.setup_id WHERE s.setup_id=$1 AND s.user_id=$2",
      [ctx.setupId, ctx.userId],
    );
    if (rows instanceof Error) return rows;
    const row = rows[0];
    if (row === undefined)
      return new IntegrationSetupError({ detail: "Setup not found" });
    const parsed = errore.try({
      // SAFETY: Only this service writes data, serializing IntegrationSetup without credentials.
      try: () => JSON.parse(row.data) as StoredSetup,
      catch: (cause) =>
        new IntegrationServiceError({ detail: "read setup", cause }),
    });
    if (parsed instanceof Error) return parsed;
    return {
      ...parsed,
      status: row.status,
      ownerLabel: row.owner_label ?? undefined,
    };
  }

  // Issues a single-use link that binds the browser opening it to this setup.
  async createSetupHandoff(ctx: {
    userId: string;
    setupId: string;
    ownerLabel: string;
  }) {
    const setup = await this.readSetup(ctx);
    if (setup instanceof Error) return setup;
    if (setup.status !== "awaiting_credentials")
      return new IntegrationSetupError({
        detail: "Setup is no longer awaiting credentials",
      });
    const handoff = crypto.randomBytes(32).toString("base64url");
    const saved = await this.sql(
      "INSERT INTO halo_integration_setup_browser (setup_id,handoff_hash,handoff_expires_at,owner_label) VALUES ($1,$2,$3,$4) ON CONFLICT (setup_id) DO UPDATE SET handoff_hash=excluded.handoff_hash, handoff_expires_at=excluded.handoff_expires_at, owner_label=excluded.owner_label",
      [
        ctx.setupId,
        secretHash(handoff),
        Date.now() + handoffTtlMs,
        ctx.ownerLabel,
      ],
    );
    if (saved instanceof Error) return saved;
    // The fragment keeps the handoff out of request URLs and logs.
    return {
      url: `${this.setupUrl(ctx.setupId)}#handoff=${encodeURIComponent(handoff)}`,
    };
  }

  // Consumes a handoff once and returns the secret for that browser's cookie.
  async redeemSetupHandoff(ctx: { setupId: string; handoff: string }) {
    const browser = crypto.randomBytes(32).toString("base64url");
    const rows = await this.sql(
      "UPDATE halo_integration_setup_browser SET handoff_hash=NULL, browser_hash=$1 WHERE setup_id=$2 AND handoff_hash=$3 AND handoff_expires_at > $4 RETURNING *",
      [secretHash(browser), ctx.setupId, secretHash(ctx.handoff), Date.now()],
    );
    if (rows instanceof Error) return rows;
    if (rows.length === 0)
      return new IntegrationSetupError({
        detail: "This setup link has expired or was already used",
      });
    return { browser };
  }

  // Returns the setup owner when the browser secret belongs to this setup.
  async setupOwnerForBrowser(ctx: { setupId: string; browser: string }) {
    const rows = await this.sql(
      "SELECT s.user_id FROM halo_integration_setup s JOIN halo_integration_setup_browser b ON b.setup_id=s.setup_id WHERE s.setup_id=$1 AND b.browser_hash=$2",
      [ctx.setupId, secretHash(ctx.browser)],
    );
    if (rows instanceof Error) return rows;
    return rows[0]?.user_id;
  }

  async submitSetup(ctx: {
    userId: string;
    setupId: string;
    template: string;
    values?: Record<string, string>;
  }) {
    const setup = await this.readSetup(ctx);
    if (setup instanceof Error) return setup;
    if (setup.status !== "awaiting_credentials")
      return new IntegrationSetupError({
        detail: "Setup is no longer awaiting credentials",
      });
    const method = setup.methods.find(
      (candidate) => candidate.template === ctx.template,
    );
    if (method === undefined)
      return new IntegrationSetupError({
        detail: "Unknown authentication method",
      });
    if (setup.reconnect && setup.reconnect.template !== ctx.template)
      return new IntegrationSetupError({
        detail: "Reconnect must use the existing authentication method",
      });
    const values = ctx.values ?? {};
    if (
      Object.keys(values).some((key) => !method.fields.includes(key)) ||
      method.fields.some((key) => !values[key])
    )
      return new IntegrationSetupError({
        detail: "Supply only the required credential fields",
      });
    // An abandoned browser may never poll its expired setup again.
    const expired = await this.sql(
      "UPDATE halo_integration_setup SET status='expired',oauth_state=NULL WHERE user_id=$1 AND integration=$2 AND connection_name=$3 AND status='authorizing' AND expires_at <= $4 AND (oauth_state IS NULL OR oauth_state NOT IN ('submitting','consuming') OR expires_at <= $5) RETURNING *",
      [
        ctx.userId,
        setup.integration,
        setup.connectionName,
        Date.now(),
        Date.now() - 30_000,
      ],
    );
    if (expired instanceof Error) return expired;
    const claimed = await this.sql(
      "UPDATE halo_integration_setup SET status='authorizing',oauth_state='submitting' WHERE setup_id=$1 AND user_id=$2 AND status='awaiting_credentials' AND expires_at > $3 AND NOT EXISTS (SELECT 1 FROM halo_integration_setup other WHERE other.user_id=$4 AND other.integration=$5 AND other.connection_name=$6 AND (other.status='authorizing' OR (other.status='ready' AND $7=0))) RETURNING *",
      [
        ctx.setupId,
        ctx.userId,
        Date.now(),
        ctx.userId,
        setup.integration,
        setup.connectionName,
        setup.reconnect ? 1 : 0,
      ],
    );
    if (claimed instanceof Error) return claimed;
    if (claimed.length === 0)
      return new IntegrationSetupError({
        detail:
          "Setup is no longer awaiting credentials or its connection name is already taken",
      });
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const failed = await this.failSetupClaim({ ...ctx, claim: "submitting" });
      if (failed instanceof Error) console.error(failed);
    });
    const redirectUri = `${this.publicOrigin}/api/integrations/oauth/callback`;
    const result = await this.withUser(ctx.userId, (executor) =>
      executor.haloSetups.run({
        setupId: ctx.setupId,
        connection: (connected) =>
          connected instanceof Error || connected.status !== "connected"
            ? undefined
            : connected.connection,
        operation: Effect.gen(function* () {
          const integration = yield* executor.integrations.get(
            IntegrationSlug.make(setup.integration),
          );
          if (integration === null)
            return new IntegrationSetupError({
              detail: "Integration not found",
            });
          const input = {
            owner: Owner.make("user"),
            name: ConnectionName.make(setup.connectionName),
            integration: integration.slug,
            template: AuthTemplateSlug.make(ctx.template),
          };
          const existing = yield* executor.connections.get(input);
          if (existing !== null && !setup.reconnect)
            return new IntegrationSetupError({
              detail: "Connection name is already taken",
            });
          if (
            setup.reconnect &&
            (existing === null ||
              existing.template !== setup.reconnect.template ||
              (existing.oauthClient ?? undefined) !== setup.reconnect.client ||
              (existing.oauthClientOwner ?? undefined) !==
                setup.reconnect.clientOwner)
          )
            return new IntegrationSetupError({
              detail: "The connection changed; restart reconnect",
            });
          if (method.kind !== "oauth")
            return {
              status: "connected" as const,
              connection: yield* executor.connections.create({
                ...input,
                values,
                identityLabel: existing?.identityLabel,
              }),
            };
          if (setup.reconnect) {
            if (!setup.reconnect.client || !setup.reconnect.clientOwner)
              return new IntegrationSetupError({
                detail: "The connection has no OAuth client binding",
              });
            return yield* executor.oauth.start({
              ...input,
              client: OAuthClientSlug.make(setup.reconnect.client),
              clientOwner: Owner.make(setup.reconnect.clientOwner),
              redirectUri,
            });
          }
          const descriptor = integration.authMethods.find(
            (item) => item.template === ctx.template,
          )?.oauth;
          const clients = yield* executor.oauth.listClients();
          const client = clients.find(
            (candidate) =>
              candidate.authorizationUrl === descriptor?.authorizationUrl &&
              candidate.tokenUrl === descriptor?.tokenUrl,
          );
          const discovered =
            client === undefined && descriptor?.discoveryUrl !== undefined
              ? yield* executor.oauth.probe({ url: descriptor.discoveryUrl })
              : undefined;
          const matching =
            client ??
            clients.find(
              (candidate) =>
                candidate.authorizationUrl === discovered?.authorizationUrl &&
                candidate.tokenUrl === discovered?.tokenUrl,
            );
          const slug =
            matching?.slug ??
            (!discovered?.registrationEndpoint
              ? undefined
              : yield* executor.oauth.registerDynamicClient({
                  owner: Owner.make("user"),
                  slug: OAuthClientSlug.make(`setup-${setup.setupId}`),
                  issuer: discovered.issuer,
                  registrationEndpoint: discovered.registrationEndpoint,
                  authorizationUrl: discovered.authorizationUrl,
                  tokenUrl: discovered.tokenUrl,
                  resource: discovered.resource,
                  scopes: discovered.scopesSupported ?? [],
                  tokenEndpointAuthMethodsSupported:
                    discovered.tokenEndpointAuthMethodsSupported,
                  redirectUri,
                  originIntegration: integration.slug,
                  clientName: "Halo",
                }));
          if (slug === undefined)
            return new IntegrationSetupError({
              detail:
                "No configured OAuth client matches this integration; the server does not support dynamic registration",
            });
          return yield* executor.oauth.start({
            ...input,
            client: slug,
            clientOwner: matching?.owner ?? Owner.make("user"),
            redirectUri,
          });
        }),
      }),
    );
    if (result instanceof Error) {
      const failed = await this.finishSetup({
        ...ctx,
        setup,
        claim: "submitting",
        status: "failed",
        message:
          result instanceof IntegrationSetupError
            ? result.message
            : "Connection setup failed. Restart setup to try again.",
      });
      if (failed instanceof Error) return failed;
      return result;
    }
    if (result.status === "connected") {
      const saved = await this.confirmSetup({
        ...ctx,
        setup,
        connection: safeConnection(result.connection),
      });
      if (saved instanceof Error) console.warn(saved);
      return {};
    }
    const safeAuthorization = await this.validateRemoteUrl(
      result.authorizationUrl,
    );
    if (safeAuthorization instanceof Error) {
      const cancelled = await this.withUser(ctx.userId, (executor) =>
        executor.oauth.cancel(result.state),
      );
      if (cancelled instanceof Error) return cancelled;
      const failed = await this.finishSetup({
        ...ctx,
        setup,
        claim: "submitting",
        status: "failed",
        message: "The provider returned an unsafe authorization URL.",
      });
      if (failed instanceof Error) return failed;
      return safeAuthorization;
    }
    const saved = await this.sql(
      "UPDATE halo_integration_setup SET oauth_state=$1 WHERE setup_id=$2 AND user_id=$3 AND status='authorizing' AND oauth_state='submitting' RETURNING *",
      [result.state, ctx.setupId, ctx.userId],
    );
    if (saved instanceof Error || saved.length === 0) {
      const cancelled = await this.withUser(ctx.userId, (executor) =>
        executor.oauth.cancel(result.state),
      );
      if (cancelled instanceof Error) console.error(cancelled);
      return saved instanceof Error
        ? saved
        : new IntegrationSetupError({
            detail:
              "Setup is no longer authorizing. Restart setup to try again.",
          });
    }
    return {
      authorizationUrl: withAccountChoice(result.authorizationUrl),
    };
  }

  // Runs on every exit after a claim. Success clears/replaces the marker, making
  // this a no-op; duplicate requests never acquire a claim or install cleanup.
  private async failSetupClaim(ctx: {
    userId: string;
    setupId: string;
    claim: "submitting" | "consuming";
  }) {
    const receipt = await this.withUser(ctx.userId, (executor) =>
      executor.haloSetups.get(ctx.setupId),
    );
    if (receipt instanceof Error) return receipt;
    if (receipt !== null) return;
    const saved = await this.sql(
      "UPDATE halo_integration_setup SET status='failed',oauth_state=NULL WHERE setup_id=$1 AND user_id=$2 AND status='authorizing' AND oauth_state=$3 RETURNING *",
      [ctx.setupId, ctx.userId, ctx.claim],
    );
    if (saved instanceof Error) return saved;
  }

  private async confirmSetup(ctx: {
    userId: string;
    setupId: string;
    setup: IntegrationSetup;
    connection: IntegrationConnection;
  }) {
    const saved = await this.sql(
      "UPDATE halo_integration_setup SET status='ready',data=$1,oauth_state=NULL WHERE setup_id=$2 AND user_id=$3 RETURNING *",
      [
        JSON.stringify({
          ...ctx.setup,
          status: "ready",
          connection: ctx.connection,
          message: undefined,
        }),
        ctx.setupId,
        ctx.userId,
      ],
    );
    if (saved instanceof Error) return saved;
    if (saved.length === 0)
      return new IntegrationSetupError({
        detail: "Connection saved; confirming status. Do not reconnect.",
      });
  }

  private async finishSetup(ctx: {
    userId: string;
    setupId: string;
    setup: IntegrationSetup;
    claim: "submitting" | "consuming";
    status: IntegrationSetup["status"];
    connection?: IntegrationConnection;
    message?: string;
  }) {
    const saved = await this.sql(
      "UPDATE halo_integration_setup SET status=$1,data=$2,oauth_state=NULL WHERE setup_id=$3 AND user_id=$4 AND status='authorizing' AND oauth_state=$5 RETURNING *",
      [
        ctx.status,
        JSON.stringify({
          ...ctx.setup,
          status: ctx.status,
          connection: ctx.connection,
          message: ctx.message,
        }),
        ctx.setupId,
        ctx.userId,
        ctx.claim,
      ],
    );
    if (saved instanceof Error) return saved;
    if (saved.length === 0)
      return new IntegrationSetupError({
        detail: "Setup is no longer authorizing. Restart setup to try again.",
      });
  }

  async cancelSetup(ctx: { userId: string; setupId: string }) {
    const setup = await this.setup(ctx);
    if (setup instanceof Error) return setup;
    if (setup.status === "confirming")
      return new IntegrationSetupError({
        detail: "Connection already saved; confirming status",
      });
    // Claim cancellation before calling the SDK; a racing callback cannot consume the state.
    const rows = await this.sql(
      "UPDATE halo_integration_setup SET status='cancelled' WHERE setup_id=$1 AND user_id=$2 AND status IN ('awaiting_credentials','authorizing') AND (oauth_state IS NULL OR oauth_state NOT IN ('submitting','consuming')) RETURNING *",
      [ctx.setupId, ctx.userId],
    );
    if (rows instanceof Error) return rows;
    if (rows.length === 0 && setup.status === "authorizing")
      return new IntegrationSetupError({
        detail:
          "Credential submission or authorization completion is in progress",
      });
    const state = rows[0]?.oauth_state;
    if (state)
      return await this.withUser(ctx.userId, (executor) =>
        executor.oauth.cancel(OAuthState.make(state)),
      );
  }

  async oauthCallback(ctx: {
    state: string;
    code?: string;
    // The Halo user signed in to this browser, if any.
    userId?: string;
    // Setup browser secrets read from this browser's cookies.
    browsers: ReadonlyMap<string, string>;
  }) {
    // Only the browser that started the setup, or its owner, may finish it.
    const pending = await this.sql(
      "SELECT setup_id, user_id FROM halo_integration_setup WHERE oauth_state=$1",
      [ctx.state],
    );
    if (pending instanceof Error) return pending;
    const owner = pending[0];
    if (owner === undefined)
      return new IntegrationSetupError({
        detail: "Invalid or already consumed OAuth state",
      });
    const browser = ctx.browsers.get(owner.setup_id);
    const browserOwner =
      browser === undefined
        ? undefined
        : await this.setupOwnerForBrowser({
            setupId: owner.setup_id,
            browser,
          });
    if (browserOwner instanceof Error) return browserOwner;
    if (ctx.userId !== owner.user_id && browserOwner !== owner.user_id)
      return new IntegrationSetupError({
        detail: "This browser did not start the setup",
      });
    // Atomic durable claim provides single consumption even with multiple control-plane replicas.
    const rows = await this.sql(
      "UPDATE halo_integration_setup SET oauth_state='consuming' WHERE oauth_state=$1 AND oauth_state NOT IN ('submitting','consuming') AND status='authorizing' AND expires_at > $2 RETURNING *",
      [ctx.state, Date.now()],
    );
    if (rows instanceof Error) return rows;
    const row = rows[0];
    if (row === undefined)
      return new IntegrationSetupError({
        detail: "Invalid or already consumed OAuth state",
      });
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const failed = await this.failSetupClaim({
        userId: row.user_id,
        setupId: row.setup_id,
        claim: "consuming",
      });
      if (failed instanceof Error) console.error(failed);
    });
    const setup = await this.setup({
      userId: row.user_id,
      setupId: row.setup_id,
    });
    if (setup instanceof Error) return setup;
    if (setup.status !== "authorizing")
      return new IntegrationSetupError({
        detail: "Authorization setup has expired",
      });
    const connection = await this.withUser(row.user_id, (executor) =>
      Effect.gen(function* () {
        if (ctx.code === undefined) {
          yield* executor.oauth.cancel(OAuthState.make(ctx.state));
          return new IntegrationSetupError({
            detail: "Authorization was declined",
          });
        }
        return yield* executor.haloSetups.run({
          setupId: row.setup_id,
          connection: (value) => value,
          operation: executor.oauth.complete({
            state: OAuthState.make(ctx.state),
            code: ctx.code,
          }),
        });
      }),
    );
    if (connection instanceof Error) {
      const saved = await this.finishSetup({
        userId: row.user_id,
        setupId: row.setup_id,
        setup,
        claim: "consuming",
        status: "failed",
        message: "Authorization failed. Restart setup to try again.",
      });
      if (saved instanceof Error) return saved;
      return { setupUrl: this.setupUrl(row.setup_id) };
    }
    const labeled = await this.labelAccount(row.user_id, connection);
    if (labeled instanceof Error) console.warn(labeled);
    const saved = await this.confirmSetup({
      userId: row.user_id,
      setupId: row.setup_id,
      setup,
      connection: safeConnection(
        labeled instanceof Error ? connection : labeled,
      ),
    });
    if (saved instanceof Error) console.warn(saved);
    return { setupUrl: this.setupUrl(row.setup_id) };
  }

  // Records the mailbox a Gmail connection reads, so people and agents can tell
  // connections apart and find one by account.
  private async labelAccount(userId: string, connection: Connection) {
    if (connection.integration !== "google_gmail") return connection;
    const profile = await new GmailApi({ integrations: this }).profile({
      ownerId: userId,
      connectionAddress: connection.address,
    });
    if (profile instanceof Error) return profile;
    return await this.withUser(userId, (executor) =>
      executor.connections.update(
        {
          owner: connection.owner,
          integration: connection.integration,
          name: connection.name,
        },
        { identityLabel: profile.emailAddress.toLowerCase() },
      ),
    );
  }

  // Removes a connection, its tools and its stored OAuth tokens. Google grants
  // access per Google account and app, not per connection, so access is revoked
  // only when no other connection may share the grant.
  async removeConnection(ctx: {
    userId: string;
    integration: string;
    name: string;
  }) {
    const ref = {
      owner: Owner.make("user"),
      integration: IntegrationSlug.make(ctx.integration),
      name: ConnectionName.make(ctx.name),
    };
    const found = await this.withUser(ctx.userId, (executor) =>
      Effect.gen(function* () {
        const connection = yield* executor.connections.get(ref);
        if (connection === null) return undefined;
        const clients = yield* executor.oauth.listClients();
        const client = clients.find(
          (candidate) =>
            candidate.slug === connection.oauthClient &&
            candidate.owner === connection.oauthClientOwner,
        );
        const others = yield* executor.connections.list({ owner: ref.owner });
        const sharesGrant = others.some(
          (other) =>
            other.address !== connection.address &&
            other.oauthClient === connection.oauthClient &&
            other.oauthClientOwner === connection.oauthClientOwner &&
            // Without both accounts known, assume they may share the grant.
            (!other.identityLabel ||
              !connection.identityLabel ||
              other.identityLabel === connection.identityLabel),
        );
        return {
          connection,
          google:
            client !== undefined &&
            new URL(client.authorizationUrl).host === "accounts.google.com",
          sharesGrant,
        };
      }),
    );
    if (found instanceof Error) return found;
    if (found === undefined)
      return new IntegrationSetupError({ detail: "Connection not found" });
    const tokens = oauthTokenIds(ctx.integration, ctx.name);
    const revocation: ConnectionRevocation = !found.google
      ? "not_supported"
      : found.sharesGrant
        ? "shared"
        : await this.revokeGoogleGrant(ctx.userId, tokens);
    const removed = await this.withUser(ctx.userId, (executor) =>
      executor.connections.remove(ref),
    );
    if (removed instanceof Error) return removed;
    // Executor removes the connection but leaves its tokens in Halo's store.
    for (const token of [tokens.access, tokens.refresh]) {
      const deleted = await this.credentials.delete(ctx.userId, token);
      if (deleted instanceof Error) return deleted;
    }
    return { revocation };
  }

  private async revokeGoogleGrant(
    userId: string,
    tokens: { access: string; refresh: string },
  ): Promise<ConnectionRevocation> {
    const refresh = await this.credentials.get(userId, tokens.refresh);
    if (refresh instanceof Error) return "failed";
    const access =
      refresh === undefined
        ? await this.credentials.get(userId, tokens.access)
        : undefined;
    if (access instanceof Error) return "failed";
    const token = refresh ?? access;
    if (token === undefined) return "failed";
    const response = await fetch(this.googleRevokeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
    }).catch(
      (cause) => new IntegrationServiceError({ detail: "revoke", cause }),
    );
    if (response instanceof Error) return "failed";
    // Google answers invalid_token when the grant is already gone.
    if (response.ok) return "revoked";
    const body = await response.text().catch(() => "");
    return body.includes("invalid_token") ? "revoked" : "failed";
  }

  async registerOpenAPI(ctx: {
    userId: string;
    name: string;
    slug: string;
    url: string;
  }) {
    const safe = await this.validateRemoteUrl(ctx.url);
    if (safe instanceof Error) return safe;
    return await this.withUser(ctx.userId, (executor) =>
      Effect.asVoid(
        executor.openapi.addSpec({
          name: ctx.name,
          slug: ctx.slug,
          spec: { kind: "url", url: ctx.url },
        }),
      ),
    );
  }

  async registerMcp(ctx: {
    userId: string;
    name: string;
    slug: string;
    endpoint: string;
    auth: "none" | "bearer" | "oauth";
  }) {
    const safe = await this.validateRemoteUrl(ctx.endpoint);
    if (safe instanceof Error) return safe;
    return await this.withUser(ctx.userId, (executor) =>
      Effect.asVoid(
        executor.mcp.addServer({
          name: ctx.name,
          slug: ctx.slug,
          endpoint: ctx.endpoint,
          authenticationTemplate:
            ctx.auth === "oauth"
              ? [{ slug: "oauth2", kind: "oauth2" }]
              : ctx.auth === "none"
                ? [{ slug: "none", kind: "none" }]
                : [
                    {
                      slug: "bearer",
                      type: "apiKey",
                      headers: {
                        Authorization: [
                          "Bearer ",
                          { type: "variable", name: "token" },
                        ],
                      },
                    },
                  ],
        }),
      ),
    );
  }

  private async validateRemoteUrl(value: string) {
    const url = errore.try({
      try: () => new URL(value),
      catch: (cause) =>
        new IntegrationSetupError({ detail: "Invalid remote URL", cause }),
    });
    if (url instanceof Error) return url;
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      return new IntegrationSetupError({ detail: "Unsafe remote URL" });
    if (this.allowLocalUrls) return;
    if (url.protocol !== "https:")
      return new IntegrationSetupError({
        detail: "Remote integrations require HTTPS",
      });
    const addresses = await dns
      .lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true })
      .catch(
        (cause) =>
          new IntegrationSetupError({
            detail: "Remote host could not be resolved",
            cause,
          }),
      );
    if (addresses instanceof Error) return addresses;
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => !publicAddress(address))
    )
      return new IntegrationSetupError({
        detail: "Remote URL must resolve to a public network",
      });
  }

  private safeFetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
    allowEventStream = false,
  ) => {
    const request = new Request(input, init);
    if (this.gmailTransport.getStore() === true) {
      const url = new URL(request.url);
      const gmail =
        (url.origin === "https://gmail.googleapis.com" ||
          url.origin === "https://www.googleapis.com") &&
        url.pathname.startsWith("/gmail/v1/users/");
      const oauth =
        (url.origin === "https://oauth2.googleapis.com" &&
          url.pathname === "/token") ||
        (url.origin === "https://accounts.google.com" &&
          url.pathname === "/o/oauth2/token");
      const localDriver =
        this.allowLocalUrls &&
        this.gmailApiOrigin !== undefined &&
        url.origin === this.gmailApiOrigin;
      if (!gmail && !oauth && !localDriver)
        throw new IntegrationSetupError({
          detail: "Gmail triggers require an authentic Google Gmail endpoint",
        });
    }

    const safe = await this.validateRemoteUrl(request.url);
    if (safe instanceof Error) throw safe;
    const body =
      request.body === null
        ? undefined
        : Buffer.from(await request.arrayBuffer());
    // Check the addresses returned to the actual socket, not just an earlier
    // DNS preflight. Keep the original hostname for Host and TLS verification.
    return await new Promise<Response>((resolve, reject) => {
      const transport = request.url.startsWith("https:") ? https : http;
      const outgoing = transport.request(
        request.url,
        {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          signal: request.signal,
          lookup: (hostname, options, callback) => {
            void dns
              .lookup(hostname, { all: true, family: options.family })
              .then((addresses) => {
                if (
                  addresses.length === 0 ||
                  (!this.allowLocalUrls &&
                    addresses.some(({ address }) => !publicAddress(address)))
                ) {
                  callback(
                    new IntegrationSetupError({
                      detail: "Remote URL must resolve to a public network",
                    }),
                    "",
                    4,
                  );
                  return;
                }
                callback(
                  // oxlint-disable-next-line unicorn/no-null -- Node's DNS callback requires null for success.
                  null,
                  options.all ? addresses : addresses[0]!.address,
                  addresses[0]!.family,
                );
              })
              .catch((cause) =>
                callback(
                  new IntegrationSetupError({
                    detail: "Remote host could not be resolved",
                    cause,
                  }),
                  "",
                  4,
                ),
              );
          },
        },
        (incoming) => {
          const status = incoming.statusCode ?? 500;
          if (status >= 300 && status < 400) {
            incoming.destroy();
            reject(
              new IntegrationSetupError({
                detail: "Remote redirects are not allowed",
              }),
            );
            return;
          }
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value === undefined) continue;
            for (const item of Array.isArray(value) ? value : [value])
              headers.append(key, item);
          }
          const encoding = headers.get("content-encoding");
          const decoder =
            encoding === "gzip"
              ? zlib.createGunzip()
              : encoding === "deflate"
                ? zlib.createInflate()
                : encoding === "br"
                  ? zlib.createBrotliDecompress()
                  : undefined;
          if (decoder !== undefined) {
            headers.delete("content-encoding");
            headers.delete("content-length");
            incoming.once("error", (error) => decoder.destroy(error));
            decoder.once("close", () => incoming.destroy());
          }
          const readable =
            decoder === undefined ? incoming : incoming.pipe(decoder);
          const eventStream =
            allowEventStream &&
            headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ===
              "text/event-stream";
          const size = { bytes: 0, emptyLine: true, carriageReturn: false };
          const bounded = new stream.Transform({
            transform(chunk: Buffer, _encoding, callback) {
              if (!eventStream) size.bytes += chunk.length;
              else
                for (const byte of chunk) {
                  // SSE accepts LF, CRLF and CR, including delimiters split across chunks.
                  if (size.carriageReturn && byte === 10) {
                    size.carriageReturn = false;
                    continue;
                  }
                  size.carriageReturn = byte === 13;
                  size.bytes++;
                  if (size.bytes > maxRemoteResponseBytes) break;
                  if (byte === 10 || byte === 13) {
                    if (size.emptyLine) size.bytes = 0;
                    size.emptyLine = true;
                  } else size.emptyLine = false;
                }
              if (size.bytes > maxRemoteResponseBytes) {
                callback(
                  new IntegrationSetupError({
                    detail:
                      "Remote response exceeds 64 MiB after decompression. Use pagination or request less data.",
                  }),
                );
                return;
              }
              callback(undefined, chunk);
            },
          });
          readable.once("error", (error) => bounded.destroy(error));
          bounded.once("close", () => readable.destroy());
          // SAFETY: Node's IncomingMessage and zlib transforms produce byte streams.
          const responseBody =
            request.method === "HEAD" || [204, 205, 304].includes(status)
              ? undefined
              : (stream.Readable.toWeb(
                  readable.pipe(bounded),
                ) as ReadableStream<Uint8Array>);
          if (responseBody === undefined) bounded.destroy();
          const response = errore.try({
            try: () => new Response(responseBody, { status, headers }),
            catch: (cause) =>
              new IntegrationServiceError({
                detail: "read remote response",
                cause,
              }),
          });
          if (response instanceof Error) {
            incoming.destroy();
            reject(response);
            return;
          }
          resolve(response);
        },
      );
      outgoing.once("error", reject);
      outgoing.end(body);
    });
  };

  private safeHttpLayer(allowEventStream = false) {
    return FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(
          FetchHttpClient.Fetch,
          async (input, init) =>
            await this.safeFetch(input, init, allowEventStream),
        ),
      ),
    );
  }

  async connections(userId: string) {
    return await this.withUser(userId, (executor) =>
      Effect.gen(function* () {
        const connections = yield* executor.connections.list({
          owner: Owner.make("user"),
        });
        return connections.map((connection): IntegrationConnection => ({
          address: connection.address,
          integration: connection.integration,
          name: connection.name,
          accountLabel: connection.identityLabel ?? undefined,
        }));
      }),
    );
  }

  async search(ctx: {
    userId: string;
    query: string;
    integration?: string;
    limit?: number;
    signal?: AbortSignal;
  }) {
    return await this.withUser(
      ctx.userId,
      (executor) =>
        Effect.gen(function* () {
          const tools = (yield* executor.tools.list({
            query: ctx.query,
            integration:
              ctx.integration === undefined
                ? undefined
                : IntegrationSlug.make(ctx.integration),
          })).filter(isIntegrationTool);
          const limit = ctx.limit ?? 50;
          return {
            tools: tools.slice(0, limit).map(summarizeTool),
            truncated: tools.length > limit,
          };
        }),
      ctx.signal,
    );
  }

  async describe(ctx: {
    userId: string;
    address: string;
    signal?: AbortSignal;
  }) {
    return await this.withUser(
      ctx.userId,
      (executor) =>
        Effect.gen(function* () {
          const tool = yield* resolveTool(executor, ctx.address);
          if (tool instanceof Error) return tool;
          const schema = yield* executor.tools.schema(tool.address);
          if (schema === null) return new IntegrationToolNotFoundError();
          const json = serializeJson(schema);
          if (json instanceof Error) return json;
          // SAFETY: Serialization preserves the SDK schema object's keys and checks JSON compatibility.
          const wire = json as {
            inputSchema?: IntegrationJson;
            outputSchema?: IntegrationJson;
            schemaDefinitions?: IntegrationJson;
            inputTypeScript?: string;
            outputTypeScript?: string;
          };
          return {
            ...summarizeTool(tool),
            inputSchema: wire.inputSchema,
            outputSchema: wire.outputSchema,
            schemaDefinitions: wire.schemaDefinitions,
            inputTypeScript: wire.inputTypeScript,
            outputTypeScript: wire.outputTypeScript,
            requiresApproval: tool.annotations?.requiresApproval,
          } satisfies IntegrationToolSchema;
        }),
      ctx.signal,
    );
  }

  async invoke(ctx: {
    userId: string;
    address: string;
    arguments: Record<string, IntegrationJson>;
    signal?: AbortSignal;
  }) {
    const result = await this.withUser(
      ctx.userId,
      (executor) =>
        Effect.gen(function* () {
          const tool = yield* resolveTool(executor, ctx.address);
          if (tool instanceof Error) return tool;
          return yield* executor.execute(tool.address, ctx.arguments).pipe(
            Effect.match({
              onFailure: (error): IntegrationInvocation => {
                if (error instanceof ToolBlockedError)
                  return { status: "blocked" };
                if (error instanceof ElicitationDeclinedError)
                  return { status: "approval_required" };
                if (
                  (error instanceof CredentialResolutionError &&
                    error.reauthRequired === true) ||
                  error instanceof ConnectionNotFoundError
                )
                  return {
                    status: "connection_required",
                    integration: tool.integration,
                    connectionName: tool.connection,
                  };
                return {
                  status: "failed",
                  code: "outcome_unknown",
                  message:
                    "Integration invocation failed; do not automatically retry.",
                };
              },
              onSuccess: (value): IntegrationInvocation => {
                if (isToolResult(value) && !value.ok) {
                  if (
                    (value.error.code === "connection_rejected" &&
                      value.error.status === 401) ||
                    value.error.code === "oauth_scope_insufficient"
                  )
                    return {
                      status: "connection_required",
                      integration: tool.integration,
                      connectionName: tool.connection,
                    };
                  const timeout =
                    value.error.code === "upstream_response_headers_timeout" ||
                    value.error.code === "upstream_response_body_timeout";
                  return {
                    status: "failed",
                    code: timeout ? "outcome_unknown" : "tool_failed",
                    message: timeout
                      ? "Integration response timed out; do not automatically retry."
                      : "The integration reported a tool error.",
                  };
                }
                const json = serializeJson(
                  isToolResult(value) && value.ok ? value.data : value,
                );
                if (json instanceof Error)
                  return {
                    status: "failed",
                    code: "outcome_unknown",
                    message:
                      "Integration returned an unsupported result; do not automatically retry.",
                  };
                return { status: "completed", result: json };
              },
            }),
          );
        }),
      ctx.signal,
    );
    if (result instanceof IntegrationToolNotFoundError) return result;
    if (result instanceof Error)
      return {
        status: "failed",
        code: "outcome_unknown",
        message:
          "Integration invocation interrupted or unavailable; do not automatically retry.",
      } satisfies IntegrationInvocation;
    return result;
  }

  // Bind the transport only after Executor initialization. No credential or arbitrary
  // integration metadata leaves the user scope; edited specs cannot forge a mailbox.
  async withGmailUser<A, E>(
    userId: string,
    run: (executor: IntegrationExecutor) => Effect.Effect<A, E>,
    signal: AbortSignal,
  ) {
    return await this.withUser(
      userId,
      (executor) =>
        Effect.promise(
          async () =>
            await this.gmailTransport.run(
              true,
              async () => await Effect.runPromise(run(executor), { signal }),
            ),
        ),
      signal,
    );
  }

  // Internal boundary only. RPC callers derive userId from runtime authentication.
  // Callbacks must not retain the executor.
  async withUser<A, E>(
    userId: string,
    run: (executor: IntegrationExecutor) => Effect.Effect<A, E>,
    signal?: AbortSignal,
  ) {
    if (this.closed)
      return new IntegrationServiceError({ detail: "service is closed" });
    this.activeUsers.set(userId, (this.activeUsers.get(userId) ?? 0) + 1);
    const work = this.run(userId, run, signal);
    this.active.add(work);
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(() => {
      this.active.delete(work);
      const count = this.activeUsers.get(userId)! - 1;
      if (count === 0) this.activeUsers.delete(userId);
      else this.activeUsers.set(userId, count);
    });
    return await work;
  }

  private async run<A, E>(
    userId: string,
    run: (executor: IntegrationExecutor) => Effect.Effect<A, E>,
    signal?: AbortSignal,
  ) {
    let pending = this.executors.get(userId);
    if (pending === undefined) {
      const evicted =
        this.executors.size >= 100
          ? [...this.executors.keys()].find(
              (id) => !this.activeUsers.has(id) && !this.initializing.has(id),
            )
          : undefined;
      if (this.executors.size >= 100 && evicted === undefined)
        return new IntegrationServiceError({
          detail: "all Executor slots are busy",
        });
      const previous =
        evicted === undefined ? undefined : this.executors.get(evicted);
      if (evicted !== undefined) this.executors.delete(evicted);
      this.initializing.add(userId);
      pending = (async () => {
        await using cleanup = new errore.AsyncDisposableStack();
        cleanup.defer(() => {
          this.initializing.delete(userId);
        });
        const old = await previous;
        if (old !== undefined && !(old instanceof Error)) {
          const closed = await Effect.runPromise(old.close()).catch(
            (cause) =>
              new IntegrationServiceError({ detail: "evict Executor", cause }),
          );
          if (closed instanceof Error) return closed;
        }
        return await this.create(userId);
      })();
      this.executors.set(userId, pending);
    }
    const initialization = pending;
    const executors = this.executors;
    return await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* Effect.promise(
          async () => await initialization,
        );
        if (executor instanceof Error) {
          if (executors.get(userId) === initialization)
            executors.delete(userId);
          return executor;
        }
        return yield* run(executor);
      }),
      { signal },
    ).catch(
      (cause) =>
        new IntegrationServiceError({ detail: "execute operation", cause }),
    );
  }

  private async create(userId: string) {
    const executor = await Effect.runPromise(
      createExecutor({
        tenant: Tenant.make(userId),
        subject: Subject.make(userId),
        db: this.database,
        fetch: this.safeFetch,
        httpClientLayer: this.safeHttpLayer(),
        firstPartyOAuthClients: this.firstPartyOAuthClients,
        providers: [this.credentialProvider(userId)],
        plugins: this.plugins,
        onElicitation: () => Effect.succeed({ action: "decline" as const }),
      }).pipe(Effect.timeout("30 seconds")),
    ).catch(
      (cause) =>
        new IntegrationServiceError({ detail: "create Executor", cause }),
    );
    if (executor instanceof Error) return executor;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const result = await Effect.runPromise(executor.close()).catch(
        (cause) =>
          new IntegrationServiceError({ detail: "close Executor", cause }),
      );
      if (result instanceof Error) console.error(result);
    });
    // Native fallback covers existing and future connections. Explicit restrictions still win.
    const approved = await Effect.runPromise(
      Effect.gen(function* () {
        const policies = yield* executor.policies.list();
        if (
          policies.some(
            (policy) =>
              policy.owner === "org" &&
              policy.pattern === "*" &&
              policy.action === "approve",
          )
        )
          return;
        yield* executor.policies.create({
          owner: Owner.make("org"),
          pattern: "*",
          action: "approve",
        });
      }).pipe(Effect.timeout("30 seconds")),
    ).catch(
      (cause) =>
        new IntegrationServiceError({
          detail: "configure default approval",
          cause,
        }),
    );
    if (approved instanceof Error) return approved;
    for (const preset of presets) {
      const { defaultSlug, url, specFormat } = preset;
      if (
        defaultSlug === undefined ||
        url === undefined ||
        specFormat === undefined
      )
        return new IntegrationServiceError({
          detail: `preset ${preset.id} cannot be installed`,
        });
      const installed = await Effect.runPromise(
        Effect.gen(function* () {
          const existing = yield* executor.integrations.get(
            IntegrationSlug.make(defaultSlug),
          );
          if (existing !== null) return;
          yield* executor.openapi.addSpec({
            spec: { kind: "url", url },
            slug: defaultSlug,
            name: preset.name,
            description: preset.summary,
            specFormat,
            family: preset.family,
            authenticationTemplate: preset.authTemplate?.flatMap((method) =>
              method.kind === "oauth2" ? [method] : [],
            ),
            healthCheck: preset.healthCheck,
          });
        }).pipe(Effect.timeout("30 seconds")),
      ).catch(
        (cause) =>
          new IntegrationServiceError({
            detail: `install ${preset.id}`,
            cause,
          }),
      );
      if (installed instanceof Error) return installed;
    }
    cleanup.move();
    return executor;
  }

  private credentialProvider(userId: string): CredentialProvider {
    return {
      key: ProviderKey.make("halo"),
      writable: true,
      get: (credentialId: ProviderItemId) =>
        toEffect("get credential", async () => {
          const value = await this.credentials.get(userId, credentialId);
          // oxlint-disable-next-line unicorn/no-null -- Executor's provider contract uses null for absence.
          return value === undefined ? null : value;
        }),
      has: (credentialId: ProviderItemId) =>
        toEffect("check credential", async () => {
          const value = await this.credentials.get(userId, credentialId);
          if (value instanceof Error) return value;
          return value !== undefined;
        }),
      set: (credentialId: ProviderItemId, value: string) =>
        toEffect(
          "set credential",
          async () => await this.credentials.set(userId, credentialId, value),
        ),
      delete: (credentialId: ProviderItemId) =>
        toEffect(
          "delete credential",
          async () => await this.credentials.delete(userId, credentialId),
        ),
      list: () =>
        toEffect<ProviderEntry[]>("list credentials", async () => {
          const ids = await this.credentials.list(userId);
          if (ids instanceof Error) return ids;
          return ids.map((id) => ({ id: ProviderItemId.make(id), name: id }));
        }),
    };
  }

  async close() {
    this.closed = true;
    await Promise.all(this.active);
    const executors = await Promise.all(this.executors.values());
    this.executors.clear();
    const results = await Promise.all(
      executors.map(async (executor) => {
        if (executor instanceof Error) return;
        return await Effect.runPromise(executor.close()).catch(
          (cause) =>
            new IntegrationServiceError({ detail: "close Executor", cause }),
        );
      }),
    );
    return results.find((result) => result instanceof Error);
  }
}

function setupCatalogEntry(
  integration: Integration,
): IntegrationSetupCatalogEntry {
  return {
    integration: integration.slug,
    name: integration.name,
    methods: integration.authMethods.map((method) => ({
      template: method.template,
      label: method.label,
      kind: method.kind,
      fields:
        method.kind === "oauth" || method.kind === "none"
          ? []
          : [
              ...new Set(
                (method.placements ?? [])
                  .filter((placement) => placement.literal === undefined)
                  .map((placement) => placement.variable ?? "token"),
              ),
            ],
    })),
  };
}

const googleRevokeUrl = "https://oauth2.googleapis.com/revoke";

// Executor stores a user connection's OAuth tokens under these credential IDs
// (accessItemId and refreshItemIdFor in @executor-js/sdk 1.6).
function oauthTokenIds(integration: string, name: string) {
  const access = `oauth:user:${integration}:${name}`;
  return { access, refresh: `${access}:refresh` };
}

function safeConnection(connection: Connection): IntegrationConnection {
  return {
    address: connection.address,
    integration: connection.integration,
    name: connection.name,
    accountLabel: connection.identityLabel ?? undefined,
  };
}

function publicAddress(address: string) {
  if (address.includes(":"))
    return (
      /^[23][0-9a-f]{3}:/i.test(address) &&
      !/^(2001:(db8|0):|2002:|3fff:)/i.test(address)
    );
  const [a, b] = address.split(".").map(Number);
  return (
    a !== undefined &&
    b !== undefined &&
    a > 0 &&
    a < 224 &&
    a !== 10 &&
    a !== 127 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0 || b === 2 || b === 88)) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19 || b === 51)) &&
    !(a === 203 && b === 0)
  );
}

function isIntegrationTool(tool: Tool) {
  return (
    tool.static !== true &&
    (tool.pluginId === "openapi" || tool.pluginId === "mcp") &&
    parseToolAddress(tool.address) !== null
  );
}

function summarizeTool(tool: Tool): IntegrationTool {
  return {
    address: tool.address,
    integration: tool.integration,
    connection: tool.connection,
    name: tool.name,
    description: tool.description,
  };
}

function resolveTool(executor: IntegrationExecutor, address: string) {
  return Effect.gen(function* () {
    if (parseToolAddress(address) === null)
      return new IntegrationToolNotFoundError();
    const tools = yield* executor.tools.list({ includeBlocked: true });
    return (
      tools.find(
        (tool) => tool.address === address && isIntegrationTool(tool),
      ) ?? new IntegrationToolNotFoundError()
    );
  });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Executor returns unknown; this is the SDK-to-JSON boundary.
function serializeJson(value: unknown) {
  return errore.try({
    // SAFETY: A successful JSON serialization and parse produces only JSON values.
    try: () => JSON.parse(JSON.stringify(value)) as IntegrationJson,
    catch: (cause) =>
      new IntegrationServiceError({
        detail: "serialize integration result",
        cause,
      }),
  });
}

function toEffect<A>(
  label: string,
  run: () => Promise<A | Error>,
): Effect.Effect<A, StorageError> {
  return Effect.flatMap(Effect.promise(run), (value) =>
    value instanceof Error
      ? Effect.fail(
          new StorageError({
            message: `${label}: ${value.message}`,
            cause: value,
          }),
        )
      : Effect.succeed(value),
  );
}
