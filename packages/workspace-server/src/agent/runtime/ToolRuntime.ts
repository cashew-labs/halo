import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Stream } from "@get-halo/shared/Stream";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import {
  createExecutionEngine,
  type ExecutionEngine,
  INTEGRATION_INVENTORY_HEADER,
  makeExecutorToolInvoker,
} from "@executor-js/execution/core";
import type {
  CodeExecutor,
  SandboxToolInvoker,
} from "@executor-js/codemode-core";
import {
  openApiPlugin,
  type OpenApiPluginExtension,
} from "@executor-js/plugin-openapi/core";
import {
  googleCatalog,
  googleCatalogOAuthScopesForPreset,
  googleDiscoveryAdapter,
} from "@executor-js/plugin-openapi/providers/google";
import {
  makeQuickJsExecutor,
  setQuickJSModule,
} from "@executor-js/runtime-quickjs";
import {
  AuthTemplateSlug,
  ConnectionName,
  createExecutor,
  definePlugin,
  Effect,
  type ElicitationContext,
  type Executor,
  firstPartyOAuthClientSlug,
  type FirstPartyOAuthClientConfig,
  type IntegrationPreset,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
  Owner,
  parseToolAddress,
  type Plugin,
  StorageError,
  Subject,
  Tenant,
  tool,
  ToolAddress,
  ToolResult,
  isToolResult,
} from "@executor-js/sdk/core";
import quickJsVariant from "@jitl/quickjs-singlefile-cjs-release-sync";
import { type Static, type TObject, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  newQuickJSWASMModule,
  type QuickJSWASMModule,
} from "quickjs-emscripten";
import * as errore from "errore";
import type {
  ConnectionRequest,
  OAuthCompletion,
  ToolApproval,
  ToolIdentity,
} from "@get-halo/client";
import { createExecutorDatabase } from "./createExecutorDatabase.js";
import type { DatabaseClient } from "../../storage/DatabaseClient.js";
import type {
  HaloTool,
  HaloToolContext,
  HaloToolExecution,
  HaloToolPlugin,
} from "../tools/HaloToolPlugin.js";
import type { AgentAuthority } from "./AgentAuthority.js";
import type { CredentialVault } from "./CredentialVault.js";
import { createExecutorCredentialProvider } from "./createExecutorCredentialProvider.js";

export type GoogleWebOAuthClient = {
  clientId: string;
  clientSecret: string;
};

export class ToolRuntimeError extends errore.createTaggedError({
  name: "ToolRuntimeError",
  message: "Tool runtime failed during $operation",
}) {}

export class ToolRuntimeToolNotFoundError extends errore.createTaggedError({
  name: "ToolRuntimeToolNotFoundError",
  message: 'Tool "$path" was not found',
}) {}

export class ToolInputRequiredError extends errore.createTaggedError({
  name: "ToolInputRequiredError",
  message:
    "Some operations need user input before they can run. Cards have been shown for all requested connections and approvals. Tell the user to respond to those cards. You will be notified after they respond.",
}) {
  readonly connectionRequests: ConnectionRequest[];
  readonly approvals: ToolApproval[];

  constructor(input: {
    connectionRequests: ConnectionRequest[];
    approvals: ToolApproval[];
    cause: Error | undefined;
  }) {
    super({ cause: input.cause });
    this.connectionRequests = input.connectionRequests;
    this.approvals = input.approvals;
  }
}

type HaloToolsPluginOptions = {
  plugins: readonly HaloToolPlugin[];
  executionContext: AsyncLocalStorage<ToolExecutionContext>;
  connectionRequests: ReadonlyMap<string, ConnectionRequest>;
  integrationsEnabled: boolean;
};

const showConnectionCardInputSchema = Type.Object({
  integration: Type.String({
    description: "The integration id returned by executor.integrations.list",
  }),
});

type ExecActivityUpdate =
  | {
      type: "tool.started";
      invocation: {
        id: string;
        parentId: string;
        tool: ToolIdentity;
        arguments: unknown;
      };
    }
  | {
      type: "tool.finished";
      invocationId: string;
      isError: boolean;
      result: unknown;
    };

type ToolExecutionContext = Pick<
  HaloToolContext,
  "signal" | "modelId" | "runtime" | "threadId"
> & {
  parentToolCallId?: string;
  onToolEvent?: (event: ExecActivityUpdate) => void;
  onConnectionRequest?: (request: ConnectionRequest) => void;
};

const haloToolsPlugin = definePlugin((options?: HaloToolsPluginOptions) => {
  if (options === undefined) {
    throw new Error("haloToolsPlugin requires plugins and authority");
  }
  return {
    id: "halo-tools" as const,
    storage: () => ({}),
    staticIntegrations: () => [
      {
        id: "halo",
        kind: "halo",
        name: "Halo",
        tools: [
          tool({
            name: "showConnectionCard",
            description:
              "Show the user a card where they can choose whether to connect an integration. This does not connect an account or grant access by itself. Use it proactively when the task needs an integration that has no connection; do not ask for confirmation first.",
            inputSchema: toExecutorSchema(showConnectionCardInputSchema),
            execute: (args) =>
              Effect.sync(() => {
                if (!Value.Check(showConnectionCardInputSchema, args))
                  return ToolResult.fail({
                    code: "invalid_tool_arguments",
                    message: "Expected an integration id",
                  });
                const request = options.connectionRequests.get(
                  args.integration,
                );
                if (request === undefined)
                  return ToolResult.fail({
                    code: "integration_unavailable",
                    message: options.integrationsEnabled
                      ? `Integration '${args.integration}' is not configured for connections in this workspace. No connection card was shown.`
                      : "Integrations are disabled in this workspace until they move to the control plane. No connection card was shown; approval or reconnecting cannot enable them.",
                  });
                const context = options.executionContext.getStore();
                if (context?.onConnectionRequest === undefined)
                  return ToolResult.fail({
                    code: "connection_card_context_required",
                    message:
                      "Connection cards must be requested from a thread's exec tool",
                  });
                context.onConnectionRequest(request);
                return ToolResult.ok({ status: "shown" });
              }),
          }),
        ],
      },
      ...options.plugins.map((plugin) => ({
        id: plugin.id,
        kind: "halo",
        name: plugin.name,
        tools: plugin.tools.map((haloTool) =>
          toExecutorTool({
            pluginId: plugin.id,
            haloTool,
            executionContext: options.executionContext,
          }),
        ),
      })),
    ],
  };
});

let quickJsModulePromise: Promise<QuickJSWASMModule> | undefined;

type InstallableGooglePreset = IntegrationPreset & {
  defaultSlug: string;
  specFormat: string;
  url: string;
};

// Executor 1.6 rewrites Meet's service-hosted Discovery URL to a legacy endpoint that returns 404.
const googlePresets = googleCatalog.filter(
  (preset) => preset.id !== "google-meet",
);

const installableGooglePresets = googlePresets.filter(
  (preset): preset is InstallableGooglePreset =>
    preset.defaultSlug !== undefined &&
    preset.specFormat !== undefined &&
    preset.url !== undefined,
);

const googleOpenApiPlugin = openApiPlugin({
  presets: googlePresets,
  specFormats: [googleDiscoveryAdapter],
});

const desktopGoogleOAuthClient: FirstPartyOAuthClientConfig = {
  name: "google",
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId:
    "912701444316-56kksjel6n6tqbkhki2ujd8h1u9bug1d.apps.googleusercontent.com",
  // Google desktop apps receive a secret, but Google does not treat it as confidential.
  clientSecret: "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",
  integrations: installableGooglePresets.map((preset) =>
    IntegrationSlug.make(preset.defaultSlug),
  ),
  allowedScopes: [
    ...new Set(
      googlePresets.flatMap((preset) =>
        googleCatalogOAuthScopesForPreset(preset.id),
      ),
    ),
  ],
};

function configuredOAuthClients(input: {
  googleWebOAuthClient: GoogleWebOAuthClient | undefined;
  oauthTestOrigin: string | undefined;
}) {
  const webClient: FirstPartyOAuthClientConfig | undefined =
    input.googleWebOAuthClient === undefined
      ? undefined
      : {
          ...desktopGoogleOAuthClient,
          name: "google-web",
          clientId: input.googleWebOAuthClient.clientId,
          clientSecret: input.googleWebOAuthClient.clientSecret,
        };
  const testOrigin = input.oauthTestOrigin;
  if (testOrigin === undefined)
    return { desktop: desktopGoogleOAuthClient, web: webClient };
  return {
    desktop: {
      ...desktopGoogleOAuthClient,
      tokenUrl: `${testOrigin}/token`,
    },
    web:
      webClient === undefined
        ? undefined
        : { ...webClient, tokenUrl: `${testOrigin}/token` },
  };
}

const oauthStartAddress = "executor.coreTools.oauth.start";
const oauthStartInputSchema = Type.Object({
  client: Type.String(),
  clientOwner: Type.Union([Type.Literal("org"), Type.Literal("user")]),
  owner: Type.Union([Type.Literal("org"), Type.Literal("user")]),
  name: Type.String(),
  integration: Type.String(),
  template: Type.String(),
  identityLabel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  newConnection: Type.Optional(Type.Boolean()),
});

type HaloRuntimePlugins = readonly [
  Plugin<"halo-tools", object>,
  Plugin<"openapi", OpenApiPluginExtension>,
];

function connectionRequestsForClient(
  client: FirstPartyOAuthClientConfig,
  presets: readonly InstallableGooglePreset[],
) {
  return new Map(
    presets.flatMap((preset) =>
      preset.authTemplate === undefined
        ? []
        : preset.authTemplate.flatMap((authentication) =>
            authentication.kind === "oauth2"
              ? [
                  [
                    preset.defaultSlug,
                    {
                      client: firstPartyOAuthClientSlug(client.name),
                      clientOwner: "org" as const,
                      owner: "user" as const,
                      connectionName: "default",
                      integration: preset.defaultSlug,
                      template: authentication.slug,
                    } satisfies ConnectionRequest,
                  ] as const,
                ]
              : [],
          ),
    ),
  );
}

function toExecutorTool(input: {
  pluginId: string;
  haloTool: HaloTool;
  executionContext: AsyncLocalStorage<ToolExecutionContext>;
}) {
  return tool({
    name: input.haloTool.name,
    description: input.haloTool.description,
    inputSchema: toExecutorSchema(input.haloTool.inputSchema),
    execute: (args) =>
      Effect.promise(async () => {
        // SAFETY: ToolRuntime runs every Executor invocation inside executionContext.
        const context =
          input.executionContext.getStore() as ToolExecutionContext;
        return await context.runtime.invoke({
          pluginId: input.pluginId,
          toolName: input.haloTool.name,
          args,
          signal: context.signal,
          modelId: context.modelId,
          threadId: context.threadId,
          toolCallId: context.parentToolCallId,
        });
      }).pipe(
        Effect.map((result) =>
          result instanceof Error
            ? ToolResult.fail({ code: result.name, message: result.message })
            : result.value,
        ),
      ),
  });
}

function toExecutorSchema(schema: TObject) {
  const jsonSchema = { ...schema };
  return {
    "~standard": {
      version: 1 as const,
      vendor: "halo",
      // Standard Schema validation is the Executor input boundary.
      // oxlint-disable-next-line anti-slop/no-unknown-parameters
      validate: (value: unknown) => {
        if (Value.Check(schema, value)) return { value };
        return {
          issues: [...Value.Errors(schema, value)].map((issue) => ({
            message: issue.message,
          })),
        };
      },
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}

type ToolRuntimeOptions = {
  database: DatabaseClient;
  workspaceRoot: string;
  userId: string;
  integrationsEnabled?: boolean;
  credentialVault?: CredentialVault;
  toolPlugins: readonly HaloToolPlugin[];
  authority: AgentAuthority;
  oauthRedirectUri: string;
  googleWebOAuthClient?: GoogleWebOAuthClient;
  oauthTestOrigin?: string;
};

export class ToolRuntime {
  private readonly executionChanges = new Stream<number>();
  private readonly executions = this.executionChanges.project(
    0,
    (count, delta) => count + delta,
  );
  readonly idle = this.executions.map((count) => count === 0);

  private retainExecution(): Disposable {
    this.executionChanges.append(1);
    return { [Symbol.dispose]: () => this.executionChanges.append(-1) };
  }

  static async create(input: ToolRuntimeOptions) {
    return await createToolRuntime(input);
  }

  private readonly executor: Executor<HaloRuntimePlugins>;
  private readonly engine: ExecutionEngine<Cause.YieldableError>;
  private readonly toolInvoker: SandboxToolInvoker;
  private readonly executionContext: AsyncLocalStorage<ToolExecutionContext>;
  private readonly toolPlugins: readonly HaloToolPlugin[];
  private readonly authority: AgentAuthority;
  private readonly context: Pick<HaloToolContext, "workspaceRoot" | "userId">;
  private readonly integrationNames: ReadonlyMap<string, string>;
  private readonly googleWebOAuthClientSlug: OAuthClientSlug | undefined;

  constructor(input: {
    executor: Executor<HaloRuntimePlugins>;
    engine: ExecutionEngine<Cause.YieldableError>;
    toolInvoker: SandboxToolInvoker;
    executionContext: AsyncLocalStorage<ToolExecutionContext>;
    toolPlugins: readonly HaloToolPlugin[];
    authority: AgentAuthority;
    context: Pick<HaloToolContext, "workspaceRoot" | "userId">;
    integrationNames: ReadonlyMap<string, string>;
    googleWebOAuthClientSlug: OAuthClientSlug | undefined;
  }) {
    this.executor = input.executor;
    this.engine = input.engine;
    this.toolInvoker = input.toolInvoker;
    this.executionContext = input.executionContext;
    this.toolPlugins = input.toolPlugins;
    this.authority = input.authority;
    this.context = input.context;
    this.integrationNames = input.integrationNames;
    this.googleWebOAuthClientSlug = input.googleWebOAuthClientSlug;
  }

  getToolIdentity(path: string) {
    return toolIdentity(path, this.integrationNames);
  }

  async invoke<T = unknown>(input: {
    pluginId: string;
    toolName: string;
    args: unknown;
    signal?: AbortSignal;
    modelId?: string;
    threadId?: string;
    toolCallId?: string;
    bashOutput?: HaloToolContext["bashOutput"];
  }): Promise<HaloToolExecution<T> | Error> {
    using cleanup = new errore.DisposableStack();
    cleanup.use(this.retainExecution());
    const registered = this.toolPlugins
      .find((plugin) => plugin.id === input.pluginId)
      ?.tools.find((candidate) => candidate.name === input.toolName);
    if (registered === undefined)
      return new ToolRuntimeToolNotFoundError({
        path: `${input.pluginId}.${input.toolName}`,
      });
    const denied = await this.authority.authorize({
      pluginId: input.pluginId,
      toolName: registered.name,
      requiredCapabilities: registered.requiredCapabilities,
    });
    if (denied instanceof Error) return denied;
    const result = await registered.execute(input.args, {
      ...this.context,
      runtime: this,
      signal: input.signal,
      modelId: input.modelId,
      threadId: input.threadId,
      toolCallId: input.toolCallId,
      bashOutput: input.bashOutput,
    });
    if (result instanceof Error) return result;
    // SAFETY: Typed host adapters name the registered plugin's output; dynamic callers retain unknown.
    return result as HaloToolExecution<T>;
  }

  async getAgentDescription() {
    const executorDescription = await Effect.runPromise(
      this.engine.getDescription,
    ).catch(
      (cause) =>
        new ToolRuntimeError({ operation: "agent description", cause }),
    );
    if (executorDescription instanceof Error) return executorDescription;

    const prefix = [
      "Execute JavaScript. tools and console are in scope.",
      'Return the value you need next, for example `return await tools.search({ query: "send email" })`, `return await tools.files.read({ path: "notes.md" })`, or `return await tools[path](args)`. Without return, exec reports (no result), even when a tool failed.',
      "Runtime tools do not throw for expected failures. They return { ok: true, data } or { ok: false, error }. Check result.ok.",
    ].join("\n");
    const inventoryStart = executorDescription.indexOf(
      INTEGRATION_INVENTORY_HEADER,
    );
    if (inventoryStart === -1) return prefix;
    return `${prefix}\n\n${executorDescription.slice(inventoryStart)}`;
  }

  async executeCode(input: {
    code: string;
    signal?: AbortSignal;
    modelId?: string;
    parentToolCallId: string;
    threadId?: string;
    onToolEvent?: (event: ExecActivityUpdate) => void;
    consumeApproval: (input: {
      toolPath: string;
      arguments: unknown;
    }) => boolean;
  }) {
    using cleanup = new errore.DisposableStack();
    cleanup.use(this.retainExecution());
    const connectionRequests: ConnectionRequest[] = [];
    const approvalRequests: ToolApproval[] = [];
    const execution = await this.executionContext.run(
      {
        signal: input.signal,
        modelId: input.modelId,
        runtime: this,
        parentToolCallId: input.parentToolCallId,
        threadId: input.threadId,
        onToolEvent: input.onToolEvent,
        onConnectionRequest: (request) => connectionRequests.push(request),
      },
      async () =>
        await Effect.runPromise(
          this.engine.execute(input.code, {
            onElicitation: (context) => {
              const connection = connectionInput(context);
              if (connection !== undefined) {
                connectionRequests.push(connection);
                return Effect.succeed({ action: "decline" as const });
              }
              const toolPath = sandboxPath(String(context.address));
              if (
                input.consumeApproval({
                  toolPath,
                  arguments: context.args,
                })
              ) {
                return Effect.succeed({ action: "accept" as const });
              }
              approvalRequests.push({
                id: randomUUID(),
                toolPath,
                message: context.request.message.split("\n", 1).join(),
                arguments: context.args,
                status: "pending",
              });
              return Effect.succeed({ action: "decline" as const });
            },
          }),
        ).catch(
          (cause) =>
            new ToolRuntimeError({ operation: "code execution", cause }),
        ),
    );
    if (execution instanceof Error) return execution;
    const cause =
      execution.error === undefined ? undefined : new Error(execution.error);
    if (connectionRequests.length > 0 || approvalRequests.length > 0) {
      return new ToolInputRequiredError({
        connectionRequests,
        approvals: approvalRequests,
        cause,
      });
    }
    return execution;
  }

  async invokeTool(input: {
    path: string;
    args: unknown;
    signal?: AbortSignal;
    modelId?: string;
  }) {
    using cleanup = new errore.DisposableStack();
    cleanup.use(this.retainExecution());
    const invocation = await this.executionContext.run(
      { signal: input.signal, modelId: input.modelId, runtime: this },
      async () =>
        await Effect.runPromise(
          this.executor.execute(ToolAddress.make(input.path), input.args),
        )
          .then((value) => ({ value }))
          .catch(
            (cause) =>
              new ToolRuntimeError({ operation: "tool invocation", cause }),
          ),
    );
    if (invocation instanceof Error) return invocation;
    return invocation;
  }

  async listToolPaths() {
    const tools = await Effect.runPromise(this.executor.tools.list()).catch(
      (cause) => new ToolRuntimeError({ operation: "tool listing", cause }),
    );
    if (tools instanceof Error) return tools;
    return tools.map((catalogTool) => sandboxPath(String(catalogTool.address)));
  }

  async invokePath(input: {
    path: string;
    args: unknown;
    signal?: AbortSignal;
  }): Promise<ToolResult<unknown> | ToolRuntimeError> {
    using cleanup = new errore.DisposableStack();
    cleanup.use(this.retainExecution());
    const result = await this.executionContext.run(
      { signal: input.signal, modelId: undefined, runtime: this },
      async () =>
        await Effect.runPromise(this.toolInvoker.invoke(input))
          .then((value) => {
            // SAFETY: makeExecutorToolInvoker normalizes every successful invocation to ToolResult.
            return value as ToolResult<unknown>;
          })
          .catch(
            (cause) =>
              new ToolRuntimeError({ operation: "tool invocation", cause }),
          ),
    );
    if (result instanceof Error) return result;
    return result;
  }

  async search(input: { query: string; limit?: number }) {
    const tools = await Effect.runPromise(
      this.executor.tools.list({ query: input.query }),
    ).catch(
      (cause) => new ToolRuntimeError({ operation: "tool search", cause }),
    );
    if (tools instanceof Error) return tools;
    const items = tools.map((catalogTool) => ({
      path: catalogTool.address,
      name: catalogTool.name,
      description: catalogTool.description,
    }));
    if (input.limit === undefined) return items;
    return items.slice(0, input.limit);
  }

  async describe(input: { path: string }) {
    const description = await Effect.runPromise(
      this.executor.tools.schema(ToolAddress.make(input.path)),
    ).catch(
      (cause) => new ToolRuntimeError({ operation: "tool description", cause }),
    );
    if (description instanceof Error) return description;
    if (description === null) {
      return new ToolRuntimeToolNotFoundError({ path: input.path });
    }
    return {
      path: description.address,
      name: description.name,
      description: description.description,
      inputSchema: description.inputSchema,
      outputSchema: description.outputSchema,
      inputTypeScript: description.inputTypeScript,
      outputTypeScript: description.outputTypeScript,
    };
  }

  async completeOAuth(input: { state: string; code: string }) {
    const completed = await Effect.runPromise(
      this.executor.oauth.complete({
        state: OAuthState.make(input.state),
        code: input.code,
      }),
    ).catch(
      (cause) => new ToolRuntimeError({ operation: "OAuth completion", cause }),
    );
    if (completed instanceof Error) return completed;
  }

  async startOAuth(input: ConnectionRequest & { completion: OAuthCompletion }) {
    const client =
      input.completion.kind === "client-loopback"
        ? OAuthClientSlug.make(input.client)
        : this.googleWebOAuthClientSlug;
    if (client === undefined) {
      return new ToolRuntimeError({
        operation: "start server OAuth without a web client",
      });
    }
    const started = await Effect.runPromise(
      this.executor.oauth.start({
        client,
        clientOwner: Owner.make(input.clientOwner),
        owner: Owner.make(input.owner),
        name: ConnectionName.make(input.connectionName),
        integration: IntegrationSlug.make(input.integration),
        template: AuthTemplateSlug.make(input.template),
        identityLabel: input.identityLabel,
        newConnection: input.newConnection,
        redirectUri: input.completion.redirectUri,
      }),
    ).catch(
      (cause) => new ToolRuntimeError({ operation: "OAuth start", cause }),
    );
    if (started instanceof Error) return started;
    if (started.status === "connected") return { status: "connected" as const };
    return {
      status: "redirect" as const,
      authorizationUrl: started.authorizationUrl,
      state: started.state,
    };
  }

  async cancelOAuth(state: string) {
    const cancelled = await Effect.runPromise(
      this.executor.oauth.cancel(OAuthState.make(state)),
    ).catch(
      (cause) =>
        new ToolRuntimeError({ operation: "OAuth cancellation", cause }),
    );
    if (cancelled instanceof Error) return cancelled;
  }

  async close() {
    const [executorClosed, pluginResults] = await Promise.all([
      Effect.runPromise(this.executor.close()).catch(
        (cause) => new ToolRuntimeError({ operation: "close", cause }),
      ),
      Promise.all(
        this.toolPlugins.map(async (plugin) =>
          plugin.close === undefined ? undefined : await plugin.close(),
        ),
      ),
    ]);
    if (executorClosed instanceof Error) return executorClosed;
    const pluginError = pluginResults.find((result) => result instanceof Error);
    if (pluginError instanceof Error) {
      return new ToolRuntimeError({
        operation: "tool shutdown",
        cause: pluginError,
      });
    }
  }
}

async function createToolRuntime(
  input: ToolRuntimeOptions,
): Promise<ToolRuntime | ToolRuntimeError> {
  const integrationsEnabled = input.integrationsEnabled !== false;
  if (integrationsEnabled && input.credentialVault === undefined)
    return new ToolRuntimeError({
      operation: "missing integration credential vault",
    });
  const oauthClients = configuredOAuthClients({
    googleWebOAuthClient: input.googleWebOAuthClient,
    oauthTestOrigin: input.oauthTestOrigin,
  });
  const firstPartyOAuthClients = !integrationsEnabled
    ? []
    : oauthClients.web === undefined
      ? [oauthClients.desktop]
      : [oauthClients.desktop, oauthClients.web];
  if (quickJsModulePromise === undefined) {
    quickJsModulePromise = newQuickJSWASMModule(quickJsVariant);
  }
  const quickJsModule = await quickJsModulePromise.catch(
    (cause) =>
      new ToolRuntimeError({ operation: "QuickJS initialization", cause }),
  );
  if (quickJsModule instanceof Error) return quickJsModule;
  setQuickJSModule(quickJsModule);

  const executionContext = new AsyncLocalStorage<ToolExecutionContext>();
  const connectionRequests = integrationsEnabled
    ? connectionRequestsForClient(
        oauthClients.desktop,
        installableGooglePresets,
      )
    : new Map<string, ConnectionRequest>();
  const executor = await Effect.runPromise(
    createExecutor({
      tenant: Tenant.make(input.workspaceRoot),
      subject: Subject.make(input.userId),
      plugins: [
        haloToolsPlugin({
          plugins: input.toolPlugins,
          executionContext,
          connectionRequests,
          integrationsEnabled,
        }),
        ...(integrationsEnabled ? [googleOpenApiPlugin] : []),
      ] as const,
      providers:
        integrationsEnabled && input.credentialVault !== undefined
          ? [createExecutorCredentialProvider(input.credentialVault)]
          : [],
      coreTools: integrationsEnabled ? { includeProviders: true } : undefined,
      redirectUri: input.oauthRedirectUri,
      firstPartyOAuthClients,
      db: ({ tables }) =>
        Effect.promise(
          async () => await createExecutorDatabase(input.database, tables),
        ).pipe(
          Effect.flatMap((database) => {
            if (database instanceof Error) {
              return Effect.fail(
                new StorageError({
                  message: "Failed to open Executor database",
                  cause: database,
                }),
              );
            }
            return Effect.succeed(database);
          }),
        ),
      onElicitation: "accept-all",
    }),
  ).catch((cause) => new ToolRuntimeError({ operation: "startup", cause }));
  if (executor instanceof Error) return executor;

  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(async () => {
    const closed = await Effect.runPromise(executor.close()).catch(
      (cause) => new ToolRuntimeError({ operation: "close", cause }),
    );
    if (closed instanceof Error)
      console.warn("Failed to close Executor after startup failure:", closed);
  });

  const installed = integrationsEnabled
    ? await installGooglePresets(executor)
    : undefined;
  if (installed instanceof Error) return installed;

  const integrations = await Effect.runPromise(
    executor.integrations.list(),
  ).catch(
    (cause) =>
      new ToolRuntimeError({ operation: "integration listing", cause }),
  );
  if (integrations instanceof Error) return integrations;
  const integrationNames = new Map(
    integrations.map((integration) => [
      String(integration.slug),
      integration.name,
    ]),
  );

  const engine = createExecutionEngine({
    executor,
    codeExecutor: withToolActivity({
      codeExecutor: makeQuickJsExecutor({
        timeoutMs: 2_000,
        memoryLimitBytes: 32 * 1024 * 1024,
        maxStackSizeBytes: 1024 * 1024,
      }),
      executionContext,
      integrationNames,
    }),
  });
  const runtime = new ToolRuntime({
    executor,
    engine,
    toolInvoker: makeExecutorToolInvoker(executor, { invokeOptions: {} }),
    executionContext,
    toolPlugins: input.toolPlugins,
    authority: input.authority,
    context: { workspaceRoot: input.workspaceRoot, userId: input.userId },
    integrationNames,
    googleWebOAuthClientSlug:
      oauthClients.web === undefined
        ? undefined
        : firstPartyOAuthClientSlug(oauthClients.web.name),
  });
  cleanup.move();
  return runtime;
}

function withToolActivity<E extends Cause.YieldableError>(input: {
  codeExecutor: CodeExecutor<E>;
  executionContext: AsyncLocalStorage<ToolExecutionContext>;
  integrationNames: ReadonlyMap<string, string>;
}): CodeExecutor<E> {
  return {
    timeoutMs: input.codeExecutor.timeoutMs,
    execute: (code, toolInvoker) => {
      const context = input.executionContext.getStore();
      return input.codeExecutor.execute(code, {
        invoke: (invocation) => {
          const identity = toolIdentity(
            invocation.path,
            input.integrationNames,
          );
          if (
            context?.onToolEvent === undefined ||
            context.parentToolCallId === undefined ||
            identity === undefined
          ) {
            return toolInvoker.invoke(invocation);
          }

          const invocationId = randomUUID();
          context.onToolEvent({
            type: "tool.started",
            invocation: {
              id: invocationId,
              parentId: context.parentToolCallId,
              tool: identity,
              arguments: invocation.args,
            },
          });
          return Effect.gen(function* () {
            const result = yield* Effect.exit(toolInvoker.invoke(invocation));
            if (Exit.isSuccess(result)) {
              context.onToolEvent?.({
                type: "tool.finished",
                invocationId,
                isError: isToolResult(result.value) && !result.value.ok,
                result: result.value,
              });
              return result.value;
            }
            context.onToolEvent?.({
              type: "tool.finished",
              invocationId,
              isError: true,
              result: Cause.pretty(result.cause),
            });
            return yield* Effect.failCause(result.cause);
          });
        },
      });
    },
  };
}

function toolIdentity(
  path: string,
  integrationNames: ReadonlyMap<string, string>,
): ToolIdentity | undefined {
  if (
    path === "search" ||
    path === "executor.integrations.list" ||
    path === "describe.tool"
  ) {
    return { path, displayName: "Tools", integrationId: "executor" };
  }
  const parsed = parseToolAddress(`tools.${path}`);
  const integrationId =
    parsed === null ? path.split(".")[0] : String(parsed.integration);
  if (integrationId === undefined) return undefined;
  const displayName = integrationNames.get(integrationId);
  if (displayName === undefined) return undefined;
  return { path, displayName, integrationId };
}

function sandboxPath(address: string) {
  return address.startsWith("tools.")
    ? address.slice("tools.".length)
    : address;
}

function connectionInput(
  context: ElicitationContext,
): ConnectionRequest | undefined {
  if (context.address !== oauthStartAddress) return undefined;
  if (!Value.Check(oauthStartInputSchema, context.args)) return undefined;
  const args: Static<typeof oauthStartInputSchema> = context.args;
  return {
    client: args.client,
    clientOwner: args.clientOwner,
    owner: args.owner,
    connectionName: args.name,
    integration: args.integration,
    template: args.template,
    identityLabel: args.identityLabel === null ? undefined : args.identityLabel,
    newConnection: args.newConnection,
  };
}

async function installGooglePresets(executor: Executor<HaloRuntimePlugins>) {
  if (installableGooglePresets.length !== googlePresets.length) {
    return new ToolRuntimeError({
      operation: "Google integration catalog",
      cause: new Error("Executor has a Google preset that cannot be installed"),
    });
  }

  for (const preset of installableGooglePresets) {
    const existing = await Effect.runPromise(
      executor.integrations.get(IntegrationSlug.make(preset.defaultSlug)),
    ).catch(
      (cause) =>
        new ToolRuntimeError({
          operation: `Google integration lookup (${preset.id})`,
          cause,
        }),
    );
    if (existing instanceof Error) return existing;
    if (existing !== null) continue;

    const authenticationTemplate = preset.authTemplate?.flatMap((method) =>
      method.kind === "oauth2" ? [method] : [],
    );
    const added = await Effect.runPromise(
      executor.openapi.addSpec({
        spec: { kind: "url", url: preset.url },
        slug: preset.defaultSlug,
        name: preset.name,
        description: preset.summary,
        specFormat: preset.specFormat,
        family: preset.family,
        authenticationTemplate,
        healthCheck: preset.healthCheck,
      }),
    ).catch(
      (cause) =>
        new ToolRuntimeError({
          operation: `Google integration setup (${preset.id})`,
          cause,
        }),
    );
    if (added instanceof Error) return added;
  }
}
