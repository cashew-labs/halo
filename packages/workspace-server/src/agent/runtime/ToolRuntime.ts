import { AsyncLocalStorage } from "node:async_hooks";
import type { RemoteConnectionBackend } from "./ConnectionService.js";
import type {
  IntegrationJson,
  IntegrationTool,
  IntegrationToolSchema,
  IntegrationInvocation,
} from "@get-halo/shared/controlPlaneContract";

export interface RemoteIntegrationTools {
  search(
    input: { query: string; integration?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<{ tools: IntegrationTool[]; truncated: boolean } | Error>;
  describe(
    input: { address: string },
    signal?: AbortSignal,
  ): Promise<IntegrationToolSchema | Error>;
  invoke(
    input: { address: string; arguments: Record<string, IntegrationJson> },
    signal?: AbortSignal,
  ): Promise<IntegrationInvocation | Error>;
}
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
  makeQuickJsExecutor,
  setQuickJSModule,
} from "@executor-js/runtime-quickjs";
import {
  createExecutor,
  definePlugin,
  Effect,
  type ElicitationContext,
  type Executor,
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
};

const showConnectionCardInputSchema = Type.Object({
  integration: Type.String({
    description: "The integration id returned by executor.integrations.list",
  }),
});

const searchInputSchema = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  source: Type.Optional(
    Type.Union([Type.Literal("workspace"), Type.Literal("control-plane")]),
  ),
});
const describeInputSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
});
const remoteArgumentsSchema = Type.Record(
  Type.String(),
  Type.Recursive((self) =>
    Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(self),
      Type.Record(Type.String(), self),
    ]),
  ),
);

function toolFailure(
  code: string,
  message: string,
  details?: IntegrationInvocation,
) {
  return ToolResult.fail({ code, message, details });
}

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
  collectConnectionRequest?: (request: ConnectionRequest) => void;
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
                const context = options.executionContext.getStore();
                if (context?.collectConnectionRequest === undefined)
                  return ToolResult.fail({
                    code: "connection_card_context_required",
                    message:
                      "Connection cards must be requested from a thread's exec tool",
                  });
                // Resolve catalog membership on the control plane at setup time.
                context.collectConnectionRequest({
                  kind: "control-plane",
                  integration: args.integration,
                });
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

type HaloRuntimePlugins = readonly [Plugin<"halo-tools", object>];

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
            path:
              issue.path === ""
                ? []
                : issue.path
                    .slice(1)
                    .split("/")
                    .map((part) =>
                      part.replaceAll("~1", "/").replaceAll("~0", "~"),
                    ),
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
  remoteConnections?: RemoteConnectionBackend;
  remoteIntegrationTools?: RemoteIntegrationTools;
  database: DatabaseClient;
  workspaceRoot: string;
  userId: string;
  toolPlugins: readonly HaloToolPlugin[];
  authority: AgentAuthority;
};

export class ToolRuntime {
  // Display metadata only; routing never depends on a discovery cache.
  private readonly remoteToolIdentities = new Map<string, ToolIdentity>();
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
  private readonly remoteConnections: boolean;
  private readonly remoteIntegrationTools: RemoteIntegrationTools | undefined;
  private readonly remoteConnectionBackend: RemoteConnectionBackend | undefined;
  private readonly integrationNames: ReadonlyMap<string, string>;

  constructor(input: {
    executor: Executor<HaloRuntimePlugins>;
    engine: ExecutionEngine<Cause.YieldableError>;
    toolInvoker: SandboxToolInvoker;
    executionContext: AsyncLocalStorage<ToolExecutionContext>;
    toolPlugins: readonly HaloToolPlugin[];
    authority: AgentAuthority;
    context: Pick<HaloToolContext, "workspaceRoot" | "userId">;
    remoteConnections: boolean;
    remoteIntegrationTools?: RemoteIntegrationTools;
    remoteConnectionBackend?: RemoteConnectionBackend;
    integrationNames: ReadonlyMap<string, string>;
  }) {
    this.executor = input.executor;
    this.engine = input.engine;
    this.toolInvoker = input.toolInvoker;
    this.executionContext = input.executionContext;
    this.toolPlugins = input.toolPlugins;
    this.authority = input.authority;
    this.context = input.context;
    this.remoteConnections = input.remoteConnections;
    this.remoteIntegrationTools = input.remoteIntegrationTools;
    this.remoteConnectionBackend = input.remoteConnectionBackend;
    this.integrationNames = input.integrationNames;
  }

  getToolIdentity(path: string) {
    return (
      this.remoteToolIdentities.get(path) ??
      toolIdentity(path, this.integrationNames)
    );
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
      ...(this.remoteConnections
        ? [
            `Discover with tools.search({ query, source: "control-plane" }); results contain tools, truncated and unavailableSources. Describe with tools.describe.tool({ path }). Remote paths start with integrations.; invoke the complete saved path with tools[path](args). Request account setup with tools.halo.showConnectionCard({ integration }); list current integrations with tools.executor.integrations.list({}). Credentials are entered in the control plane, never in tool arguments.`,
          ]
        : []),
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
    const collectConnectionRequest = (request: ConnectionRequest) => {
      // Released desktop clients validate the old card schema before sending
      // IPC. These routing markers are inert: setup authority stays on the CP.
      const compatible = {
        client: "control-plane",
        clientOwner: "org" as const,
        owner: "user" as const,
        template: "control-plane",
        ...request,
        connectionName: request.connectionName ?? "default",
      };
      if (
        !connectionRequests.some(
          (existing) =>
            existing.integration === compatible.integration &&
            existing.connectionName === compatible.connectionName,
        )
      )
        connectionRequests.push(compatible);
    };
    const execution = await this.executionContext.run(
      {
        signal: input.signal,
        modelId: input.modelId,
        runtime: this,
        parentToolCallId: input.parentToolCallId,
        threadId: input.threadId,
        onToolEvent: input.onToolEvent,
        collectConnectionRequest,
      },
      async () =>
        await Effect.runPromise(
          this.engine.execute(input.code, {
            onElicitation: (context) => {
              const connection = connectionInput(context);
              if (connection !== undefined) {
                collectConnectionRequest(connection);
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
    const cause =
      execution instanceof Error
        ? execution
        : execution.error === undefined
          ? undefined
          : new Error(execution.error);
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
          this.dispatch(
            {
              path: sandboxPath(input.path),
              args: input.args,
              signal: input.signal,
            },
            this.toolInvoker,
          ),
        )
          .then((value) => ({
            value: isToolResult(value) && value.ok ? value.data : value,
          }))
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
        await Effect.runPromise(this.dispatch(input, this.toolInvoker))
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

  async search(
    input: {
      query: string;
      limit?: number;
      source?: "workspace" | "control-plane";
    },
    signal?: AbortSignal,
  ) {
    if (!Value.Check(searchInputSchema, input))
      return new ToolRuntimeError({ operation: "invalid search arguments" });
    const tools = await Effect.runPromise(
      input.source === "control-plane"
        ? Effect.succeed([])
        : this.executor.tools.list({ query: input.query }),
    ).catch(
      (cause) => new ToolRuntimeError({ operation: "tool search", cause }),
    );
    if (tools instanceof Error) return tools;
    const items = tools
      .map((catalogTool) => ({
        path: sandboxPath(String(catalogTool.address)),
        name: catalogTool.name,
        description: catalogTool.description,
        source: "workspace" as const,
      }))
      .toSorted((left, right) => left.path.localeCompare(right.path));
    const limit = input.limit ?? 100;
    const remote =
      input.source === "workspace"
        ? undefined
        : this.remoteIntegrationTools === undefined
          ? new ToolRuntimeError({ operation: "remote discovery unavailable" })
          : await this.remoteIntegrationTools.search(
              { query: input.query, limit: Math.min(100, limit) },
              signal,
            );
    if (remote instanceof Error && input.source === "control-plane")
      return remote;
    if (remote instanceof Error)
      console.warn("Remote tool discovery unavailable:", remote.message);
    if (remote !== undefined && !(remote instanceof Error)) {
      for (const entry of remote.tools)
        this.remoteToolIdentities.set(`integrations.${entry.address}`, {
          path: `integrations.${entry.address}`,
          displayName: entry.name,
          integrationId: entry.integration,
        });
    }
    const combined = [
      ...items,
      ...(remote === undefined || remote instanceof Error
        ? []
        : remote.tools.map((entry) => ({
            path: `integrations.${entry.address}`,
            name: entry.name,
            description: entry.description,
            source: "control-plane" as const,
          }))),
    ];
    const unique = [
      ...new Map(combined.map((entry) => [entry.path, entry])).values(),
    ];
    return {
      tools: unique.slice(0, limit),
      truncated:
        unique.length > limit ||
        (remote !== undefined &&
          !(remote instanceof Error) &&
          remote.truncated),
      unavailableSources:
        remote instanceof Error ? ["control-plane" as const] : [],
    };
  }

  async describe(input: { path: string }, signal?: AbortSignal) {
    if (!Value.Check(describeInputSchema, input))
      return new ToolRuntimeError({
        operation: "invalid description arguments",
      });
    if (input.path.startsWith("integrations.")) {
      if (this.remoteIntegrationTools === undefined)
        return new ToolRuntimeError({
          operation: "remote description unavailable",
        });
      const schema = await this.remoteIntegrationTools.describe(
        { address: input.path.slice("integrations.".length) },
        signal,
      );
      if (schema instanceof Error) return schema;
      this.remoteToolIdentities.set(input.path, {
        path: input.path,
        displayName: schema.name,
        integrationId: schema.integration,
      });
      return { ...schema, path: input.path };
    }
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
      schemaDefinitions: description.schemaDefinitions,
      inputTypeScript: description.inputTypeScript,
      outputTypeScript: description.outputTypeScript,
    };
  }

  dispatch(
    input: { path: string; args: unknown; signal?: AbortSignal },
    local: SandboxToolInvoker,
  ): ReturnType<SandboxToolInvoker["invoke"]> {
    const context = this.executionContext.getStore();
    const signal = input.signal ?? context?.signal;
    if (
      input.path === "search" ||
      input.path === "describe.tool" ||
      (input.path === "executor.integrations.list" &&
        this.remoteConnectionBackend !== undefined) ||
      input.path.startsWith("integrations.")
    ) {
      return Effect.promise(async () => {
        const failure = toolFailure;
        if (signal?.aborted)
          return failure(
            "outcome_unknown",
            "Execution cancelled; external effects may have completed",
          );
        if (input.path === "search" || input.path === "describe.tool") {
          if (
            input.path === "search" &&
            !Value.Check(searchInputSchema, input.args)
          )
            return failure(
              "invalid_tool_arguments",
              "Invalid search arguments",
            );
          if (
            input.path === "describe.tool" &&
            !Value.Check(describeInputSchema, input.args)
          )
            return failure(
              "invalid_tool_arguments",
              "Invalid describe arguments",
            );
          // SAFETY: The corresponding discovery schema was checked above.
          const value =
            input.path === "search"
              ? await this.search(
                  input.args as Parameters<ToolRuntime["search"]>[0],
                  signal,
                )
              : await this.describe(input.args as { path: string }, signal);
          return value instanceof Error
            ? failure("discovery_failed", value.message)
            : ToolResult.ok(value);
        }
        if (
          input.path === "executor.integrations.list" &&
          this.remoteConnectionBackend !== undefined
        ) {
          const catalog = await this.remoteConnectionBackend.catalog();
          return catalog instanceof Error
            ? failure("discovery_failed", catalog.message)
            : ToolResult.ok(catalog);
        }
        if (this.remoteIntegrationTools === undefined)
          return failure("unavailable", "Remote integrations unavailable");
        const validArguments = errore.try({
          try: () => Value.Check(remoteArgumentsSchema, input.args),
          catch: (cause) =>
            new ToolRuntimeError({
              operation: "remote argument validation",
              cause,
            }),
        });
        if (validArguments instanceof Error || !validArguments)
          return failure(
            "invalid_arguments",
            "Remote arguments must be a JSON object",
          );
        // SAFETY: The recursive JSON-object schema passed before RPC dispatch.
        const args = input.args as Record<string, IntegrationJson>;
        const outcome = await this.remoteIntegrationTools.invoke(
          {
            address: input.path.slice("integrations.".length),
            arguments: args,
          },
          signal,
        );
        if (outcome instanceof Error)
          return failure("outcome_unknown", outcome.message);
        if (outcome.status === "completed")
          return ToolResult.ok(outcome.result);
        if (outcome.status === "connection_required")
          context?.collectConnectionRequest?.({
            kind: "control-plane",
            integration: outcome.integration,
            connectionName: outcome.connectionName,
          });
        return failure(
          outcome.status === "failed" ? outcome.code : outcome.status,
          outcome.status === "failed" ? outcome.message : outcome.status,
          outcome,
        );
      });
    }
    return local.invoke(input);
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
  if (
    input.toolPlugins.some(
      (plugin) =>
        plugin.id === "integrations" || plugin.id.startsWith("integrations."),
    )
  )
    return new ToolRuntimeError({
      operation: "reserved integrations namespace",
    });
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
  const executor = await Effect.runPromise(
    createExecutor({
      tenant: Tenant.make(input.workspaceRoot),
      subject: Subject.make(input.userId),
      plugins: [
        haloToolsPlugin({
          plugins: input.toolPlugins,
          executionContext,
        }),
      ] as const,
      providers: [],
      coreTools: { includeProviders: false },
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

  const integrations = await Effect.runPromise(
    executor.integrations.list(),
  ).catch(
    (cause) =>
      new ToolRuntimeError({ operation: "integration listing", cause }),
  );
  if (integrations instanceof Error) return integrations;
  const integrationNames = new Map(
    integrations.map(
      (integration) => [String(integration.slug), integration.name] as const,
    ),
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
    remoteConnections: input.remoteConnections !== undefined,
    remoteIntegrationTools: input.remoteIntegrationTools,
    remoteConnectionBackend: input.remoteConnections,
    integrationNames,
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
      const routed: SandboxToolInvoker = {
        invoke: (invocation) =>
          context === undefined
            ? toolInvoker.invoke(invocation)
            : context.runtime.dispatch(invocation, toolInvoker),
      };
      return input.codeExecutor.execute(code, {
        invoke: (invocation) => {
          const identity =
            context?.runtime.getToolIdentity(invocation.path) ??
            toolIdentity(invocation.path, input.integrationNames);
          if (
            context?.onToolEvent === undefined ||
            context.parentToolCallId === undefined ||
            identity === undefined
          ) {
            return routed.invoke(invocation);
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
            const result = yield* Effect.exit(routed.invoke(invocation));
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
  if (path.startsWith("integrations."))
    return {
      path,
      displayName: "Integration",
      integrationId: "integrations",
    };
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
    kind: "control-plane",
    integration: args.integration,
    connectionName: args.name,
  };
}
