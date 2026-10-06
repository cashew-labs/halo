import { openApiPlugin } from "@executor-js/plugin-openapi/core";
import {
  googleCatalog,
  googleDiscoveryAdapter,
} from "@executor-js/plugin-openapi/providers/google";
import {
  createExecutor,
  Effect,
  IntegrationSlug,
  Subject,
  Tenant,
  type Executor,
  type ExecutorConfig,
} from "@executor-js/sdk/core";
import * as errore from "errore";
import type { CredentialService } from "../credentials/CredentialService.js";
import type { DatabaseService } from "../DatabaseService.js";
import { createExecutorDatabase } from "./createExecutorDatabase.js";

// Executor 1.6 rewrites Meet's Discovery URL to a legacy endpoint returning 404.
const presets = googleCatalog.filter((preset) => preset.id !== "google-meet");
const plugins = [
  openApiPlugin({ presets, specFormats: [googleDiscoveryAdapter] }),
] as const;
type IntegrationExecutor = Executor<typeof plugins>;

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
  private readonly httpClientLayer: ExecutorConfig["httpClientLayer"];

  private constructor(ctx: {
    database: Exclude<
      Awaited<ReturnType<typeof createExecutorDatabase>>,
      Error
    >;
    credentials: CredentialService;
    httpClientLayer?: ExecutorConfig["httpClientLayer"];
  }) {
    this.database = ctx.database;
    this.credentials = ctx.credentials;
    this.httpClientLayer = ctx.httpClientLayer;
  }

  static async start(ctx: {
    db: DatabaseService;
    credentials: CredentialService;
    httpClientLayer?: ExecutorConfig["httpClientLayer"];
  }) {
    const database = await createExecutorDatabase(ctx.db);
    if (database instanceof Error) return database;
    return new IntegrationService({
      database,
      credentials: ctx.credentials,
      httpClientLayer: ctx.httpClientLayer,
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
        providers: [this.credentials.forUser(userId)],
        plugins,
        httpClientLayer: this.httpClientLayer,
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
