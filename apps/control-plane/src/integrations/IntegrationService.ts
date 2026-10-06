import { openApiPlugin } from "@executor-js/plugin-openapi/core";
import {
  googleCatalog,
  googleDiscoveryAdapter,
} from "@executor-js/plugin-openapi/providers/google";
import {
  createExecutor,
  Effect,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  StorageError,
  Subject,
  Tenant,
  type CredentialProvider,
  type Executor,
  type ProviderEntry,
} from "@executor-js/sdk/core";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as errore from "errore";
import type { CredentialService } from "../credentials/CredentialService.js";
import type { DatabaseService } from "../DatabaseService.js";
import { createExecutorDatabase } from "./createExecutorDatabase.js";

// Executor 1.6 rewrites Meet's Discovery URL to a legacy endpoint returning 404.
const presets = googleCatalog.filter((preset) => preset.id !== "google-meet");
type IntegrationPlugins = readonly [ReturnType<typeof openApiPlugin>];
type IntegrationExecutor = Executor<IntegrationPlugins>;

class IntegrationServiceError extends errore.createTaggedError({
  name: "IntegrationServiceError",
  message: "Integration service failed: $detail",
}) {}

export class IntegrationService {
  // Coalesce first-use initialization per user and drain all work before shutdown.
  private readonly executors = new Map<
    string,
    Promise<IntegrationExecutor | IntegrationServiceError>
  >();
  private readonly active = new Set<Promise<unknown>>();
  private closed = false;
  private readonly database: Exclude<
    Awaited<ReturnType<typeof createExecutorDatabase>>,
    Error
  >;
  private readonly credentials: CredentialService;
  private readonly plugins: IntegrationPlugins;

  private constructor(ctx: {
    database: Exclude<
      Awaited<ReturnType<typeof createExecutorDatabase>>,
      Error
    >;
    credentials: CredentialService;
    getOpenAPISpec?: (url: string) => Promise<string | Error>;
  }) {
    this.database = ctx.database;
    this.credentials = ctx.credentials;
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
    this.plugins = [
      openApiPlugin({
        presets,
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
    ];
  }

  static async start(ctx: {
    db: DatabaseService;
    credentials: CredentialService;
    getOpenAPISpec?: (url: string) => Promise<string | Error>;
  }) {
    const database = await createExecutorDatabase(ctx.db);
    if (database instanceof Error) return database;
    return new IntegrationService({
      database,
      credentials: ctx.credentials,
      getOpenAPISpec: ctx.getOpenAPISpec,
    });
  }

  // Internal boundary only. Phase 2 derives userId from authenticated runtime
  // state and exposes narrow operations; callers must not retain the executor.
  async withUser<A, E>(
    userId: string,
    run: (executor: IntegrationExecutor) => Effect.Effect<A, E>,
  ) {
    if (this.closed)
      return new IntegrationServiceError({ detail: "service is closed" });
    const work = this.run(userId, run);
    this.active.add(work);
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(() => {
      this.active.delete(work);
    });
    return await work;
  }

  private async run<A, E>(
    userId: string,
    run: (executor: IntegrationExecutor) => Effect.Effect<A, E>,
  ) {
    let pending = this.executors.get(userId);
    if (pending === undefined) {
      pending = this.create(userId);
      this.executors.set(userId, pending);
    }
    const executor = await pending;
    if (executor instanceof Error) {
      this.executors.delete(userId);
      return executor;
    }
    return await Effect.runPromise(run(executor)).catch(
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
        providers: [this.credentialProvider(userId)],
        plugins: this.plugins,
        onElicitation: () => Effect.succeed({ action: "decline" as const }),
      }),
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
        }),
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
