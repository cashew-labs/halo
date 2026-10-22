import { AsyncLocalStorage } from "node:async_hooks";
import type { RemoteConnectionBackend } from "./ConnectionService.js";
import type {
  IntegrationJson,
  IntegrationTool,
  IntegrationToolSchema,
  IntegrationInvocation,
  McpRegistration,
  ApiRegistration,
} from "@get-halo/shared/controlPlaneContract";
import {
  registerMcpInputSchema,
  registerApiInputSchema,
} from "@get-halo/shared/controlPlaneContract";

export interface RemoteIntegrationTools {
  registerMcp(
    input: McpRegistration,
    signal?: AbortSignal,
  ): Promise<void | Error>;
  registerApi(
    input: ApiRegistration,
    signal?: AbortSignal,
  ): Promise<void | Error>;
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
import nodePath from "node:path";
import nodeUtil from "node:util";
import { copyJson } from "@earendil-works/chord";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Stream } from "@get-halo/shared/Stream";
import { WorkerCodeExecutor } from "./WorkerCodeExecutor.js";
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
import { type Static, type TObject, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import type {
  ConnectionRequest,
  ToolApproval,
  ToolIdentity,
} from "@get-halo/client";
import { addConnectionCard } from "./connectionCards.js";
import {
  listConnectionsResult,
  removeConnectionResult,
} from "./connectionTools.js";
import { createExecutorDatabase } from "./createExecutorDatabase.js";
import type {
  HaloTool,
  HaloToolContext,
  HaloToolExecution,
  HaloTools,
  HaloToolServices,
} from "../tools/HaloTool.js";
import type { AgentAuthority } from "./AgentAuthority.js";

export class HaloToolInputError extends errore.createTaggedError({
  name: "HaloToolInputError",
  message: 'Invalid input for Halo tool "$tool"',
}) {}

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
  tools: readonly RegisteredHaloTool[];
  executionContext: AsyncLocalStorage<ToolExecutionContext>;
  connections?: RemoteConnectionBackend;
  integrations?: RemoteIntegrationTools;
};

const removeConnectionInputSchema = Type.Object({
  integration: Type.String({
    minLength: 1,
    description: "The connection's integration from halo.listConnections",
  }),
  name: Type.String({
    minLength: 1,
    description: "The connection's name from halo.listConnections",
  }),
});

const showConnectionCardInputSchema = Type.Object({
  integration: Type.String({
    description: "The integration id returned by executor.integrations.list",
  }),
});

const integrationListInputSchema = Type.Object({
  query: Type.Optional(Type.String()),
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
            name: "registerMcp",
            description:
              "Register a custom remote MCP server from its public HTTPS endpoint. Choose auth none, bearer, or oauth; never pass credentials here. Returns the integration id. Then use halo.showConnectionCard so the user can finish connecting. Local stdio/command servers are not supported.",
            inputSchema: toExecutorSchema(registerMcpInputSchema),
            execute: (args) =>
              Effect.promise(async () => {
                // coverage-exempt: Executor validates the shared schema before calling execute.
                if (!Value.Check(registerMcpInputSchema, args))
                  return ToolResult.fail({
                    code: "invalid_tool_arguments",
                    message: "Expected an MCP name, slug, endpoint and auth",
                  });
                if (options.integrations === undefined)
                  return ToolResult.fail({
                    code: "integrations_unavailable",
                    message: "This workspace has no control-plane integrations",
                  });
                const registered = await options.integrations.registerMcp(
                  args,
                  options.executionContext.getStore()?.signal,
                );
                if (registered instanceof Error)
                  return ToolResult.fail({
                    code: "registration_failed",
                    message: registered.message,
                  });
                return ToolResult.ok({
                  status: "registered",
                  integration: args.slug,
                });
              }),
          }),
          tool({
            name: "registerApi",
            description:
              "Register a custom API from its official public HTTPS OpenAPI or Google Discovery description URL; Google Discovery URLs are detected automatically. Find the URL in the provider's documentation when the user names a service. For Google Discovery, optionally set googleOAuthScopes to the least privilege needed; reporting should use read-only scopes. Never pass credentials here. Returns the integration id. Then use halo.showConnectionCard so the user can authorize access.",
            inputSchema: toExecutorSchema(registerApiInputSchema),
            execute: (args) =>
              Effect.promise(async () => {
                // coverage-exempt: Executor validates the shared schema before calling execute.
                if (!Value.Check(registerApiInputSchema, args))
                  return ToolResult.fail({
                    code: "invalid_tool_arguments",
                    message: "Expected an API name, slug and spec URL",
                  });
                if (options.integrations === undefined)
                  return ToolResult.fail({
                    code: "integrations_unavailable",
                    message: "This workspace has no control-plane integrations",
                  });
                const registered = await options.integrations.registerApi(
                  args,
                  options.executionContext.getStore()?.signal,
                );
                if (registered instanceof Error)
                  return ToolResult.fail({
                    code: "registration_failed",
                    message: registered.message,
                  });
                return ToolResult.ok({
                  status: "registered",
                  integration: args.slug,
                });
              }),
          }),
          tool({
            name: "showConnectionCard",
            description:
              "Show an optional connection card for an available integration. Use an integration ID from executor.integrations.list. This does not connect an account or grant access; do not ask for confirmation first.",
            inputSchema: toExecutorSchema(showConnectionCardInputSchema),
            execute: (args) =>
              Effect.promise(async () => {
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
                const catalog = await options.connections?.catalog();
                if (catalog === undefined)
                  return ToolResult.fail({
                    code: "connections_unavailable",
                    message: "This workspace has no control-plane connections",
                  });
                if (catalog instanceof Error)
                  return ToolResult.fail({
                    code: "discovery_failed",
                    message: catalog.message,
                  });
                if (
                  !catalog.some(
                    (entry) => entry.integration === args.integration,
                  )
                )
                  return ToolResult.fail({
                    code: "integration_unavailable",
                    message: `Integration '${args.integration}' is not available. Use executor.integrations.list to find available integrations. No connection card was shown.`,
                  });
                context.collectConnectionRequest({
                  kind: "control-plane",
                  integration: args.integration,
                });
                return ToolResult.ok({ status: "shown" });
              }),
          }),
          tool({
            name: "listConnections",
            description:
              "List the accounts connected to Halo's integrations, such as Gmail. Each entry has the integration, the connection name and, when known, the account. Use it to find the connection a person names.",
            inputSchema: toExecutorSchema(Type.Object({})),
            execute: () =>
              Effect.promise(
                async () => await listConnectionsResult(options.connections),
              ),
          }),
          tool({
            name: "removeConnection",
            description:
              "Remove a connected account, its tools and its stored credentials. Halo also revokes the provider's access when no other connection uses the same account. To replace an account, remove it, then show a connection card for the new account. The person approves each removal.",
            inputSchema: toExecutorSchema(removeConnectionInputSchema),
            annotations: {
              requiresApproval: true,
              approvalDescription: "Remove this connected account",
            },
            execute: (args) =>
              Effect.promise(async () => {
                // coverage-exempt: Executor validates the input schema first.
                if (!Value.Check(removeConnectionInputSchema, args))
                  return ToolResult.fail({
                    code: "invalid_tool_arguments",
                    message: "Expected an integration and a connection name",
                  });
                return await removeConnectionResult(options.connections, args);
              }),
          }),
        ],
      },
      ...[...new Set(options.tools.map((entry) => entry.namespace))].map(
        (namespace) => ({
          id: namespace,
          kind: "halo",
          name: namespaceNames.get(namespace) ?? namespace,
          tools: options.tools
            .filter((entry) => entry.namespace === namespace)
            .map((entry) =>
              toExecutorTool({
                entry,
                executionContext: options.executionContext,
              }),
            ),
        }),
      ),
    ],
  };
});

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
  entry: RegisteredHaloTool;
  executionContext: AsyncLocalStorage<ToolExecutionContext>;
}) {
  return tool({
    name: input.entry.name,
    description: input.entry.tool.description,
    inputSchema: toExecutorSchema(input.entry.tool.inputSchema),
    execute: (args) =>
      Effect.promise(async () => {
        // SAFETY: ToolRuntime runs every Executor invocation inside executionContext.
        const context =
          input.executionContext.getStore() as ToolExecutionContext;
        return await context.runtime.invoke({
          path: input.entry.path,
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
            : result.result,
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
  workspaceRoot: string;
  userId: string;
  tools: Readonly<Record<string, HaloTools>>;
  services: HaloToolServices;
  authority: AgentAuthority;
};

export class ToolRuntime {
  readonly images = new Stream<{
    threadId: string;
    parentToolCallId: string;
    image: { type: "image"; data: string; mimeType: string };
  }>();
  readonly toolActivity = new Stream<{
    threadId: string | undefined;
    parentToolCallId: string;
    event: ExecActivityUpdate;
  }>();
  readonly codeSessions: WorkerCodeExecutor;
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
  private readonly tools: ReadonlyMap<string, RegisteredHaloTool>;
  private readonly authority: AgentAuthority;
  private readonly context: Pick<
    HaloToolContext,
    "workspaceRoot" | "userId" | "services"
  >;
  private readonly remoteConnections: boolean;
  private readonly remoteIntegrationTools: RemoteIntegrationTools | undefined;
  private readonly remoteConnectionBackend: RemoteConnectionBackend | undefined;
  private readonly integrationNames: ReadonlyMap<string, string>;

  constructor(input: {
    codeSessions: WorkerCodeExecutor;
    executor: Executor<HaloRuntimePlugins>;
    engine: ExecutionEngine<Cause.YieldableError>;
    toolInvoker: SandboxToolInvoker;
    executionContext: AsyncLocalStorage<ToolExecutionContext>;
    tools: readonly RegisteredHaloTool[];
    authority: AgentAuthority;
    context: Pick<HaloToolContext, "workspaceRoot" | "userId" | "services">;
    remoteConnections: boolean;
    remoteIntegrationTools?: RemoteIntegrationTools;
    remoteConnectionBackend?: RemoteConnectionBackend;
    integrationNames: ReadonlyMap<string, string>;
  }) {
    this.codeSessions = input.codeSessions;
    this.executor = input.executor;
    this.engine = input.engine;
    this.toolInvoker = input.toolInvoker;
    this.executionContext = input.executionContext;
    this.tools = new Map(input.tools.map((entry) => [entry.path, entry]));
    this.authority = input.authority;
    this.context = input.context;
    this.remoteConnections = input.remoteConnections;
    this.remoteIntegrationTools = input.remoteIntegrationTools;
    this.remoteConnectionBackend = input.remoteConnectionBackend;
    this.integrationNames = input.integrationNames;
  }

  getToolIdentity(path: string) {
    const registered = this.tools.get(path);
    if (registered !== undefined)
      return {
        path,
        displayName:
          namespaceNames.get(registered.namespace) ?? registered.namespace,
        integrationId: registered.namespace,
      };
    return (
      this.remoteToolIdentities.get(path) ??
      toolIdentity(path, this.integrationNames)
    );
  }

  createModelTools(input: {
    threadId: string;
    modelId: string;
  }): ToolRegistration[] {
    return [...this.tools.values()].flatMap(
      ({ path: toolPath, tool: haloTool }) => {
        const modelTool = haloTool.modelTool;
        if (modelTool === undefined) return [];
        return [
          {
            name: modelTool.name,
            description: haloTool.description,
            parameters: haloTool.inputSchema,
            replay: modelTool.replay,
            execute: async (args, api, context) => {
              const result = await this.invoke({
                path: toolPath,
                args,
                ...input,
                toolCallId: api.callId,
                signal: context.abortSignal,
                bashOutput: {
                  directory: nodePath.join(
                    this.context.workspaceRoot,
                    ".halo",
                    "tool-outputs",
                    input.threadId,
                  ),
                  headChars: 8_000,
                  tailChars: 32_000,
                },
              });
              if (result instanceof Error) throw result;
              if (result.modelResult !== undefined) return result.modelResult;
              const details =
                result.result === undefined
                  ? undefined
                  : errore.try({
                      try: () =>
                        copyJson(result.result, {
                          omitUndefinedProperties: true,
                        }),
                      catch: (cause) =>
                        new ToolRuntimeError({
                          operation: "native tool result serialization",
                          cause,
                        }),
                    });
              if (details instanceof Error) {
                console.warn("Using text-only Halo tool output:", details);
                return {
                  content: [
                    {
                      type: "text",
                      text: nodeUtil.inspect(result.result, {
                        customInspect: false,
                      }),
                    },
                  ],
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(details, undefined, 2) ?? "undefined",
                  },
                ],
                details,
              };
            },
          } satisfies ToolRegistration,
        ];
      },
    );
  }

  async invoke(input: {
    path: string;
    args: unknown;
    signal?: AbortSignal;
    modelId?: string;
    threadId?: string;
    toolCallId?: string;
    bashOutput?: HaloToolContext["bashOutput"];
  }): Promise<HaloToolExecution | Error> {
    using cleanup = new errore.DisposableStack();
    cleanup.use(this.retainExecution());
    const registered = this.tools.get(input.path)?.tool;
    if (registered === undefined)
      return new ToolRuntimeToolNotFoundError({
        path: input.path,
      });
    const denied = await this.authority.authorize({
      path: input.path,
      requiredCapabilities: registered.requiredCapabilities,
    });
    if (denied instanceof Error) return denied;
    if (!Value.Check(registered.inputSchema, input.args))
      return new HaloToolInputError({ tool: input.path });
    const result = await registered.execute(input.args, {
      ...this.context,
      toolPath: input.path,
      runtime: this,
      signal: input.signal,
      modelId: input.modelId,
      threadId: input.threadId,
      toolCallId: input.toolCallId,
      bashOutput: input.bashOutput,
    });
    if (result instanceof Error) return result;
    return result;
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
      "Execute JavaScript in a persistent, thread-owned session. tools and console are in scope. Variables and functions survive calls until reset or thread unload. Native let/const redeclarations error; use var for reusable bindings. Use exec({ op: 'reset' }) to discard bindings. Reset does not undo external actions.",
      'The final expression is the result: `await tools.search({ query: "send email" })`, `await tools.files.read({ path: "notes.md" })`, or `await tools[path](args)`. Top-level return is not supported. Await tool calls; detached work cannot outlive an evaluation.',
      "Runtime tools do not throw for expected failures. They return { ok: true, data } or { ok: false, error }. Check result.ok.",
      "viewImage({ path }) attaches a workspace PNG, JPEG, or WebP directly to this exec result for model viewing. No await is needed; await returns only { ok: true } or { ok: false, error }, never image bytes. At most 8 images per evaluation; source files must be 20 MiB or smaller. Log observation text separately and viewImage(observation.data.screenshot) when present.",
      ...(this.tools.has("browser.call")
        ? [
            "tools.browser drives the workspace Chrome with Playwright pages and locators. Unlike other tools, its methods throw on failure. `var page = await tools.browser.newPage({ url })` opens a tab, and `isolated: true` opens it in a fresh incognito-style context without the user's cookies, for example to act as a second user; `await tools.browser.tabs()` lists { id, url, title } and `await tools.browser.page(id)` returns any open tab. Build locators with page.getByRole('button', { name: /save/i }), getByText, getByLabel, locator, and the like, chained with filter, first, last, nth, and, or; then await one action or query such as click, fill, press, check, selectOption, textContent, innerText, count, isVisible, waitFor, or evaluate. Pages have goto, reload, goBack, goForward, title, content, evaluate, waitForURL, waitForLoadState, keyboard.press, keyboard.type, close, snapshot(), and screenshot(). snapshot() returns an aria snapshot with [ref=s1e2] refs: act on one with page.locator('aria-ref=s1e2'), and take a new snapshot after the page changes. screenshot() attaches the image to this result. evaluate functions run in the page and cannot read exec variables; pass values as the argument. Dialogs that block an action are dismissed and logged; to accept one, first run page.evaluate(() => { window.confirm = () => true }). setInputFiles takes paths in the workspace. Element handles, frames, events, and routes are not available. The other tabs are the user's; act in them only when the task needs it, and close the tabs you open.",
          ]
        : []),
      ...(this.remoteConnections
        ? [
            `Find available integrations with tools.executor.integrations.list({ query: "integration name" }); omit query to list them all. If a requested service is missing, find its official API description or remote MCP endpoint in the provider's documentation; do not ask users to identify formats or supply URLs you can look up. Register remote MCP servers with tools.halo.registerMcp({ name, slug, endpoint, auth }) and APIs with tools.halo.registerApi({ name, slug, url, googleOAuthScopes? }); OpenAPI and official Google Discovery URLs are supported, with automatic format selection. Use least-privilege Google scopes. Show an optional connection card with tools.halo.showConnectionCard({ integration }) using an integration ID returned by listing or registration. Discover operations with tools.search({ query, source: "control-plane" }); results contain tools, truncated and unavailableSources. Describe with tools.describe.tool({ path }). Remote paths start with integrations.; invoke the complete saved path with tools[path](args). Credentials are entered in the control plane, never in tool arguments.`,
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
    consumeApproval: (input: {
      toolPath: string;
      arguments: unknown;
    }) => boolean;
  }) {
    using cleanup = new errore.DisposableStack();
    cleanup.use(this.retainExecution());
    const connectionRequests: ConnectionRequest[] = [];
    const approvalRequests: ToolApproval[] = [];
    const collectConnectionRequest = (request: ConnectionRequest) =>
      addConnectionCard(connectionRequests, request);
    const execution = await this.executionContext.run(
      {
        signal: input.signal,
        modelId: input.modelId,
        runtime: this,
        parentToolCallId: input.parentToolCallId,
        threadId: input.threadId,
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
        : this.executor.tools.list(),
    ).catch(
      (cause) => new ToolRuntimeError({ operation: "tool search", cause }),
    );
    if (tools instanceof Error) return tools;
    const query = input.query.toLowerCase();
    const items = tools
      .map((catalogTool) => ({
        path: sandboxPath(String(catalogTool.address)),
        name: catalogTool.name,
        description: catalogTool.description,
        source: "workspace" as const,
      }))
      .filter((entry) =>
        `${entry.path} ${entry.name} ${entry.description}`
          .toLowerCase()
          .includes(query),
      )
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
      path: sandboxPath(String(description.address)),
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
    // Exact local lookup precedes Executor's remote-address normalization.
    const registered = this.tools.get(input.path);
    if (registered !== undefined) {
      if (signal?.aborted)
        return Effect.succeed(
          toolFailure(
            "outcome_unknown",
            "Execution cancelled; external effects may have completed",
          ),
        );
      return local.invoke(input);
    }
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
          if (!Value.Check(integrationListInputSchema, input.args))
            return failure(
              "invalid_tool_arguments",
              "Expected an optional integration query string",
            );
          const catalog = await this.remoteConnectionBackend.catalog();
          if (catalog instanceof Error)
            return failure("discovery_failed", catalog.message);
          const query = input.args.query?.trim().toLowerCase() ?? "";
          return ToolResult.ok(
            catalog.filter(
              (entry) =>
                entry.integration.toLowerCase().includes(query) ||
                entry.name.toLowerCase().includes(query),
            ),
          );
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
    await this.codeSessions.close();
    return await Effect.runPromise(this.executor.close()).catch(
      (cause) => new ToolRuntimeError({ operation: "close", cause }),
    );
  }
}

async function createToolRuntime(
  input: ToolRuntimeOptions,
): Promise<ToolRuntime | ToolRuntimeError> {
  const tools = registerHaloTools(input.tools);
  if (tools instanceof Error) return tools;
  const executionContext = new AsyncLocalStorage<ToolExecutionContext>();
  const executor = await Effect.runPromise(
    createExecutor({
      tenant: Tenant.make(input.workspaceRoot),
      subject: Subject.make(input.userId),
      plugins: [
        haloToolsPlugin({
          tools,
          executionContext,
          connections: input.remoteConnections,
          integrations: input.remoteIntegrationTools,
        }),
      ] as const,
      providers: [],
      coreTools: { includeProviders: false },
      db: ({ tables }) =>
        Effect.promise(
          async () =>
            await createExecutorDatabase(input.services.database, tables),
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

  // Executor's sandbox invoker prefixes org/user-shaped paths with "tools.".
  // Restore exact static addresses at execute so its policy and elicitation gates still run.
  const staticAddresses = new Map(
    tools.map((entry) => [`tools.${entry.path}`, entry.path]),
  );
  const toolExecutor: typeof executor = {
    ...executor,
    execute: (address, args, options) =>
      executor.execute(
        ToolAddress.make(
          staticAddresses.get(String(address)) ?? String(address),
        ),
        args,
        options,
      ),
  };
  const codeSessions = new WorkerCodeExecutor();
  const engine = createExecutionEngine({
    executor: toolExecutor,
    codeExecutor: withToolActivity({
      codeExecutor: {
        execute: (code, invoker) => {
          const context = executionContext.getStore();
          if (!context?.threadId)
            return Effect.succeed({
              result: undefined,
              error: "Code evaluation requires a thread",
            });
          let imageCount = 0;
          return Effect.promise(
            async () =>
              await codeSessions.evaluate({
                threadId: context.threadId!,
                code,
                invoker,
                signal: context.signal,
                viewImage: async (reference, signal) => {
                  if (signal.aborted)
                    return toolFailure("cancelled", "Image emission cancelled");
                  if (++imageCount > 8)
                    return toolFailure(
                      "image_limit",
                      "At most 8 images may be emitted per evaluation",
                    );
                  // Use the existing authorized, validated file-image boundary directly.
                  // Image bytes must not pass through Executor serialization or guest tool results.
                  const result = await context.runtime.invoke({
                    path: "files.viewImage",
                    args: reference,
                    signal,
                    modelId: context.modelId,
                    threadId: context.threadId,
                    toolCallId: context.parentToolCallId,
                  });
                  if (result instanceof Error)
                    return toolFailure(result.name, result.message);
                  if (signal.aborted)
                    return toolFailure("cancelled", "Image emission cancelled");
                  const image = result.modelResult?.content?.find(
                    (part) => part.type === "image",
                  );
                  if (image === undefined)
                    return toolFailure(
                      "image_context",
                      "Image tool returned no image",
                    );
                  if (image.data.length > 8 * 1024 * 1024)
                    return toolFailure(
                      "image_limit",
                      "Resized image exceeded 8 MiB of encoded data",
                    );
                  if (context.parentToolCallId === undefined)
                    return toolFailure(
                      "image_context",
                      "Image emission requires an exec tool call",
                    );
                  context.runtime.images.append({
                    threadId: context.threadId!,
                    parentToolCallId: context.parentToolCallId,
                    image,
                  });
                  return ToolResult.ok(undefined);
                },
              }),
          );
        },
      },
      executionContext,
      integrationNames,
    }),
  });
  const runtime = new ToolRuntime({
    codeSessions,
    executor,
    engine,
    toolInvoker: makeExecutorToolInvoker(toolExecutor, { invokeOptions: {} }),
    executionContext,
    tools,
    authority: input.authority,
    context: {
      workspaceRoot: input.workspaceRoot,
      userId: input.userId,
      services: input.services,
    },
    remoteConnections: input.remoteConnections !== undefined,
    remoteIntegrationTools: input.remoteIntegrationTools,
    remoteConnectionBackend: input.remoteConnections,
    integrationNames,
  });
  cleanup.move();
  return runtime;
}

type RegisteredHaloTool = {
  path: string;
  namespace: string;
  name: string;
  tool: HaloTool;
};

const namespaceNames = new Map([
  ["files", "Workspace files"],
  ["database", "Workspace database"],
  ["hotkeys", "Keyboard shortcuts"],
  ["automations", "Automations"],
  ["thread", "Workspace threads"],
  ["bash", "Workspace shell"],
  ["web", "Web Search"],
  ["browser", "Browser"],
]);

function isHaloTool(value: HaloTool | HaloTools): value is HaloTool {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Trusted definitions have execute functions; namespace children are objects.
  return typeof value.execute === "function";
}

function registerHaloTools(tools: Readonly<Record<string, HaloTools>>) {
  const registered: RegisteredHaloTool[] = [];
  const modelNames = new Set(["exec"]);
  const visit = (
    group: HaloTools,
    segments: readonly string[],
  ): ToolRuntimeError | undefined => {
    for (const [key, value] of Object.entries(group)) {
      if (key.length === 0 || key.includes(".") || key === "then")
        return new ToolRuntimeError({
          operation: `invalid tool key ${[...segments, key].join(".")}`,
        });
      if (
        segments.length === 0 &&
        [
          "integrations",
          "executor",
          "halo",
          "search",
          "describe",
          "tools",
        ].includes(key)
      )
        return new ToolRuntimeError({
          operation: `reserved tool namespace ${key}`,
        });
      const path = [...segments, key];
      if (!isHaloTool(value)) {
        const error = visit(value, path);
        if (error instanceof Error) return error;
        continue;
      }
      if (segments.length === 0)
        return new ToolRuntimeError({
          operation: `tool ${key} requires a namespace`,
        });
      const modelName = value.modelTool?.name;
      if (modelName !== undefined && modelNames.has(modelName))
        return new ToolRuntimeError({
          operation: `duplicate model tool name ${modelName}`,
        });
      if (modelName !== undefined) modelNames.add(modelName);
      registered.push({
        path: path.join("."),
        namespace: path[0]!,
        name: path.slice(1).join("."),
        tool: value,
      });
    }
  };
  const error = visit(tools, []);
  if (error instanceof Error) return error;
  return registered;
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
            context?.parentToolCallId === undefined ||
            identity === undefined
          ) {
            return routed.invoke(invocation);
          }

          const invocationId = randomUUID();
          const publish = (event: ExecActivityUpdate) => {
            context.runtime.toolActivity.append({
              threadId: context.threadId,
              parentToolCallId: context.parentToolCallId!,
              event,
            });
          };
          publish({
            type: "tool.started",
            invocation: {
              id: invocationId,
              parentId: context.parentToolCallId,
              tool: identity,
              arguments: invocation.args,
            },
          });
          return routed.invoke(invocation).pipe(
            Effect.onExit((result) =>
              Effect.sync(() => {
                publish(
                  Exit.isSuccess(result)
                    ? {
                        type: "tool.finished",
                        invocationId,
                        isError: isToolResult(result.value) && !result.value.ok,
                        result: result.value,
                      }
                    : {
                        type: "tool.finished",
                        invocationId,
                        isError: true,
                        result: Cause.pretty(result.cause),
                      },
                );
              }),
            ),
          );
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
