import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import { ORPCError } from "@orpc/client";
import { isDeepStrictEqual } from "node:util";
import {
  createHaloClient,
  type ExtensionArtifact,
  type HaloClient,
} from "@get-halo/client";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import {
  validateAppDefinition,
  type AppAction,
  type AppAccess,
  type AppJson,
  type AppDefinition,
  type AppSummary,
} from "@get-halo/shared/extensionSharing";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import type { WorkspaceProviderApi } from "../workspace/provider/WorkspaceProviderApi.js";
import type { WorkspaceAuthorization } from "../workspace/proxy.js";
import type { IntegrationService } from "../integrations/IntegrationService.js";
import type { AppCredentials } from "./AppCredentials.js";
import { AppConflictError, type AppRecord, type AppStore } from "./AppStore.js";
import { creatorOrigin } from "./creatorHost.js";

export class AppRequestError extends errore.createTaggedError({
  name: "AppRequestError",
  message: "$reason",
}) {}

export class AppLimitError extends errore.createTaggedError({
  name: "AppLimitError",
  message: "This app reached its usage limit; try again later",
}) {}

// Every app shares these per-app fixed windows across visitors. Each model
// step of an app conversation is one inference request.
const usageWindowMs = 10 * 60_000;
const actionLimit = 120;
const inferenceLimit = 1_000;

export class AppRemoteError extends errore.createTaggedError({
  name: "AppRemoteError",
  message: "App VM request failed: $operation",
}) {}

const manifestSchema = Type.Object({
  halo: Type.Optional(
    Type.Object({
      displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      app: Type.Optional(Type.Unknown()),
    }),
  ),
});

/**
 * Owns published apps. Publication is a resumable sequence recorded in
 * AppStore: freeze the local project, copy it to the app VM, then replace the
 * local project with a remote reference. Each step is idempotent, so a retry
 * after any interruption continues without a second live copy.
 */
export class AppService {
  // Publication steps run one at a time per owner on this instance; the
  // store's stage checks guard against other instances.
  private readonly publications = new Map<
    string,
    { queue: SerialQueue; pending: number }
  >();
  private readonly store: AppStore;
  private readonly credentials: AppCredentials;
  private readonly workspace: WorkspaceService;
  private readonly provider: WorkspaceProviderApi;
  private readonly authorization: WorkspaceAuthorization;
  private readonly integrations: IntegrationService | undefined;
  private readonly publicOrigin: string;
  private readonly readyTimeoutMs: number;

  constructor(ctx: {
    store: AppStore;
    credentials: AppCredentials;
    workspace: WorkspaceService;
    provider: WorkspaceProviderApi;
    authorization: WorkspaceAuthorization;
    integrations: IntegrationService | undefined;
    publicOrigin: string;
    readyTimeoutMs?: number;
  }) {
    this.store = ctx.store;
    this.credentials = ctx.credentials;
    this.workspace = ctx.workspace;
    this.provider = ctx.provider;
    this.authorization = ctx.authorization;
    this.integrations = ctx.integrations;
    this.publicOrigin = ctx.publicOrigin;
    this.readyTimeoutMs = ctx.readyTimeoutMs ?? 10 * 60_000;
  }

  async list(ownerUserId: string) {
    const apps = await this.store.list(ownerUserId);
    if (apps instanceof Error) return apps;
    const summaries: AppSummary[] = [];
    for (const app of apps) {
      const summary = await this.summarize(app);
      if (summary instanceof Error) return summary;
      summaries.push(summary);
    }
    return summaries;
  }

  async publish(ctx: {
    ownerUserId: string;
    ownerEmail: string;
    extensionId: string;
    slug?: string;
    access: AppAccess;
  }) {
    const slug = ctx.slug ?? ctx.extensionId.slice(0, 63).replace(/-+$/, "");
    // Template demos use demo-* paths on the same creator host.
    if (slug.startsWith("demo-"))
      return new AppRequestError({
        reason: "App links cannot start with demo-",
      });
    // Check before freezing, so an unsupported host never stops the extension.
    if (this.provider.hostsSharedApps !== true)
      return new AppRequestError({
        reason: "This Halo deployment cannot host shared apps",
      });
    return await this.serialize(ctx.ownerUserId, async () => {
      const handle = await this.store.ensureHandle({
        userId: ctx.ownerUserId,
        email: ctx.ownerEmail,
      });
      if (handle instanceof Error) return handle;
      const created = await this.store.create({
        ownerUserId: ctx.ownerUserId,
        extensionId: ctx.extensionId,
        slug,
        displayName: ctx.extensionId,
        visibility: ctx.access.visibility,
        members: ctx.access.members,
        syncAccess: "read-only",
        actions: [],
      });
      if (created instanceof Error) return created;
      // A retry may change who can visit, never which app is published.
      const app = await this.store.updateAccess({
        appId: created.appId,
        access: ctx.access,
        published: true,
      });
      if (app instanceof Error) return app;
      const live = await this.continuePublication(app);
      if (live instanceof Error) return live;
      return await this.summarize(live);
    });
  }

  async update(ctx: {
    ownerUserId: string;
    appId: string;
    access?: AppAccess;
    published?: boolean;
  }) {
    const app = await this.owned(ctx);
    if (app instanceof Error) return app;
    const updated = await this.store.updateAccess(ctx);
    if (updated instanceof Error) return updated;
    return await this.summarize(updated);
  }

  /**
   * Abandons a publication that has not reached its app VM and restarts the
   * local project. Once the app VM runs the copy, only publishing again
   * finishes the cutover, so two live copies never exist.
   */
  async cancel(ctx: { ownerUserId: string; appId: string }) {
    return await this.serialize(ctx.ownerUserId, async () => {
      const app = await this.owned(ctx);
      if (app instanceof Error) return app;
      if (app.stage === "live")
        return new AppRequestError({
          reason: "Published apps are unpublished, not cancelled",
        });
      if (app.stage === "ready")
        return new AppRequestError({
          reason: "The app already runs on its VM; publish it again to finish",
        });
      const owner = await this.ownerClient(app.ownerUserId);
      if (owner instanceof Error) return owner;
      return await this.abandon({ app, owner });
    });
  }

  /** Owner-confirmed fixed requests; app code can never change them. */
  async bindActions(ctx: {
    ownerUserId: string;
    appId: string;
    actions: AppAction[];
  }) {
    const app = await this.owned(ctx);
    if (app instanceof Error) return app;
    const validated = await this.validateActions({
      ownerUserId: app.ownerUserId,
      actions: ctx.actions,
    });
    if (validated instanceof Error) return validated;
    const replaced = await this.store.replaceActions({
      appId: app.appId,
      actions: validated,
    });
    if (replaced instanceof Error) return replaced;
    return await this.summarize(app);
  }

  async readSource(ctx: { ownerUserId: string; appId: string; name: string }) {
    const target = await this.remoteApp(ctx);
    if (target instanceof Error) return target;
    return await target.client.extensions
      .readSource({ id: target.app.extensionId, name: ctx.name })
      .catch(remoteFailure("read"));
  }

  async writeSource(ctx: {
    ownerUserId: string;
    appId: string;
    name: string;
    contents: string;
  }) {
    const target = await this.remoteApp(ctx);
    if (target instanceof Error) return target;
    return await target.client.extensions
      .writeSource({
        id: target.app.extensionId,
        name: ctx.name,
        contents: ctx.contents,
      })
      .catch(remoteFailure("write"));
  }

  async execSource(ctx: {
    ownerUserId: string;
    appId: string;
    command: string;
  }) {
    const target = await this.remoteApp(ctx);
    if (target instanceof Error) return target;
    return await target.client.extensions
      .execSource({ id: target.app.extensionId, command: ctx.command })
      .catch(remoteFailure("build"));
  }

  async restart(ctx: { ownerUserId: string; appId: string }) {
    const target = await this.remoteApp(ctx);
    if (target instanceof Error) return target;
    return await target.client.extensions
      .restart({ id: target.app.extensionId })
      .catch(remoteFailure("restart"));
  }

  /**
   * Runs one owner-bound request for an app VM. The caller names the action;
   * it may repeat the fixed arguments but never change or add to them.
   */
  async invokeAction(ctx: {
    app: AppRecord;
    name: string;
    arguments: Record<string, AppJson> | undefined;
    signal?: AbortSignal;
  }) {
    const actions = await this.store.actions(ctx.app.appId);
    if (actions instanceof Error) return actions;
    const action = actions.find((candidate) => candidate.name === ctx.name);
    if (action === undefined)
      return new AppRequestError({ reason: "Unknown app action" });
    if (
      ctx.arguments !== undefined &&
      !isDeepStrictEqual(ctx.arguments, action.arguments)
    )
      return new AppRequestError({
        reason: "App actions run only their fixed request",
      });
    const allowed = await this.store.consume({
      appId: ctx.app.appId,
      kind: "action",
      limit: actionLimit,
      windowMs: usageWindowMs,
    });
    if (allowed instanceof Error) return allowed;
    if (!allowed) return new AppLimitError();
    // coverage-exempt: Actions can be bound only when integrations are configured.
    if (this.integrations === undefined)
      return new AppRequestError({
        reason: "Integration actions are unavailable",
      });
    return await this.integrations.invoke({
      userId: ctx.app.ownerUserId,
      address: action.address,
      arguments: action.arguments,
      signal: ctx.signal,
    });
  }

  /** What an app VM may offer in conversations: stored, not read from app code. */
  async runtimeDefinition(app: AppRecord) {
    const actions = await this.store.actions(app.appId);
    if (actions instanceof Error) return actions;
    const instructions = await this.store.instructions(app.appId);
    if (instructions instanceof Error) return instructions;
    return {
      displayName: app.displayName,
      instructions: instructions ?? "",
      actions: actions.map((action) => ({
        name: action.name,
        description: action.description,
      })),
    };
  }

  /** Counts one model request for an app; false once its window is spent. */
  async consumeInference(app: AppRecord) {
    return await this.store.consume({
      appId: app.appId,
      kind: "inference",
      limit: inferenceLimit,
      windowMs: usageWindowMs,
    });
  }

  /** Verifies an app VM's own runtime token; it never grants owner authority. */
  async authenticateRuntime(authorization: string | undefined) {
    const claimed = this.credentials.read(authorization);
    if (claimed === undefined) return undefined;
    const app = await this.store.get(claimed.appId);
    if (app instanceof Error) return app;
    if (app === undefined || app.credentialGeneration !== claimed.generation)
      return undefined;
    return app;
  }

  private async continuePublication(app: AppRecord) {
    const current =
      app.stage === "frozen" ? await this.installFrozen(app) : app;
    if (current instanceof Error) return current;
    if (current.stage !== "ready") return current;
    const owner = await this.ownerClient(current.ownerUserId);
    if (owner instanceof Error) return owner;
    // The app VM is authoritative; only now does the owner keep a reference.
    const referenced = await owner.extensions
      .completePublication({
        id: current.extensionId,
        appId: current.appId,
        url: `${this.url(current)}view/`,
        displayName: current.displayName,
      })
      .catch(remoteFailure("store reference"));
    if (referenced instanceof Error) return referenced;
    return await this.store.advance({
      appId: current.appId,
      from: "ready",
      to: "live",
    });
  }

  private async installFrozen(app: AppRecord) {
    const owner = await this.ownerClient(app.ownerUserId);
    if (owner instanceof Error) return owner;
    const frozen = await owner.extensions
      .freeze({ id: app.extensionId, appId: app.appId })
      .catch(remoteFailure("freeze"));
    // A refused freeze changed nothing locally; drop the record and its link.
    if (frozen instanceof AppRequestError) {
      const deleted = await this.store.delete(app.appId);
      if (deleted instanceof Error) return deleted;
      return frozen;
    }
    if (frozen instanceof Error) return frozen;
    // The frozen project cannot change, so a retry copies identical content.
    const artifact = await owner.extensions
      .snapshot({ id: app.extensionId })
      .catch(remoteFailure("snapshot"));
    const defined =
      artifact instanceof Error
        ? artifact
        : await this.define({ app, artifact });
    // An invalid or unexportable app never leaves the owner's workspace.
    if (defined instanceof AppRequestError) {
      const abandoned = await this.abandon({ app, owner });
      if (abandoned instanceof Error) return abandoned;
      return defined;
    }
    if (defined instanceof Error || artifact instanceof Error) return defined;
    const provisioned = await this.provider.ensure({
      workspaceId: defined.appId,
      ownerUserId: defined.ownerUserId,
      runtime: {
        origin: this.publicOrigin,
        workspaceId: defined.appId,
        token: this.credentials.issue({
          appId: defined.appId,
          generation: defined.credentialGeneration,
        }),
        generation: defined.credentialGeneration,
      },
      sharedApp: {
        appId: defined.appId,
        extensionId: defined.extensionId,
        syncAccess: defined.syncAccess,
      },
    });
    if (provisioned instanceof Error) return provisioned;
    const target = await this.waitForApp(defined);
    if (target instanceof Error) return target;
    const installed = await target.extensions
      .install({
        id: defined.extensionId,
        artifact,
        installId: defined.installId,
      })
      .catch(remoteFailure("install"));
    if (installed instanceof Error) return installed;
    return await this.store.advance({
      appId: defined.appId,
      from: "frozen",
      to: "ready",
    });
  }

  /** Reads the app definition from the frozen package, with safe defaults. */
  private async define(ctx: { app: AppRecord; artifact: ExtensionArtifact }) {
    const manifest = errore.try({
      // SAFETY: manifestSchema validates the decoded JSON below.
      try: () =>
        JSON.parse(ctx.artifact.files["package.json"] ?? "") as unknown,
      catch: (cause) =>
        new AppRequestError({ reason: "package.json is invalid", cause }),
    });
    if (manifest instanceof Error) return manifest;
    if (!Value.Check(manifestSchema, manifest))
      return new AppRequestError({ reason: "package.json is invalid" });
    // Without a declaration, visitors may read synced records and nothing else.
    const definition: AppDefinition | Error =
      manifest.halo?.app === undefined
        ? { description: ctx.app.extensionId, sync: "read-only", actions: [] }
        : validateAppDefinition(manifest.halo.app);
    if (definition instanceof Error)
      return new AppRequestError({
        reason: definition.message,
        cause: definition,
      });
    const actions = await this.validateActions({
      ownerUserId: ctx.app.ownerUserId,
      actions: definition.actions,
    });
    if (actions instanceof Error) return actions;
    return await this.store.define({
      appId: ctx.app.appId,
      displayName: manifest.halo?.displayName ?? ctx.app.extensionId,
      syncAccess: definition.sync,
      instructions: definition.instructions,
      actions,
    });
  }

  private async validateActions(ctx: {
    ownerUserId: string;
    actions: AppAction[];
  }) {
    const definition = validateAppDefinition({
      description: "actions",
      sync: "actions",
      actions: ctx.actions,
    });
    if (definition instanceof Error)
      return new AppRequestError({
        reason: definition.message,
        cause: definition,
      });
    if (definition.actions.length === 0) return definition.actions;
    if (this.integrations === undefined)
      return new AppRequestError({
        reason: "Integration actions are unavailable",
      });
    for (const action of definition.actions) {
      const tool = await this.integrations.describe({
        userId: ctx.ownerUserId,
        address: action.address,
      });
      if (tool instanceof Error)
        return new AppRequestError({
          reason: `Action ${action.name} does not name one of your connected tools`,
          cause: tool,
        });
    }
    return definition.actions;
  }

  /** Restarts the frozen local project and forgets the publication. */
  private async abandon(ctx: { app: AppRecord; owner: HaloClient }) {
    const released = await ctx.owner.extensions
      .release({ id: ctx.app.extensionId, appId: ctx.app.appId })
      .catch(remoteFailure("release"));
    if (released instanceof Error) return released;
    return await this.store.delete(ctx.app.appId);
  }

  private async serialize<T>(ownerUserId: string, run: () => Promise<T>) {
    const entry = this.publications.get(ownerUserId) ?? {
      queue: new SerialQueue(),
      pending: 0,
    };
    this.publications.set(ownerUserId, entry);
    entry.pending += 1;
    try {
      return await entry.queue.run(run);
    } finally {
      entry.pending -= 1;
      if (entry.pending === 0) this.publications.delete(ownerUserId);
    }
  }

  private async owned(ctx: { ownerUserId: string; appId: string }) {
    const app = await this.store.get(ctx.appId);
    if (app instanceof Error) return app;
    if (app === undefined || app.ownerUserId !== ctx.ownerUserId)
      return new AppRequestError({ reason: "App not found" });
    return app;
  }

  private async remoteApp(ctx: { ownerUserId: string; appId: string }) {
    const app = await this.owned(ctx);
    if (app instanceof Error) return app;
    if (app.stage === "frozen")
      return new AppRequestError({ reason: "App is still being published" });
    const client = await this.appClient(app);
    if (client instanceof Error) return client;
    if (client === undefined)
      return new AppRequestError({ reason: "App VM is not reachable" });
    return { app, client };
  }

  private async summarize(app: AppRecord) {
    const actions = await this.store.actions(app.appId);
    if (actions instanceof Error) return actions;
    return {
      appId: app.appId,
      extensionId: app.extensionId,
      displayName: app.displayName,
      handle: app.handle,
      slug: app.slug,
      url: this.url(app),
      visibility: app.visibility,
      members: app.members,
      published: app.published,
      stage: app.stage === "live" ? "live" : "publishing",
      actions: actions.map((action) => ({
        name: action.name,
        description: action.description,
      })),
    } satisfies AppSummary;
  }

  private url(app: AppRecord) {
    return `${creatorOrigin({ publicOrigin: this.publicOrigin, handle: app.handle })}/${app.slug}/`;
  }

  private async ownerClient(ownerUserId: string) {
    const workspace = await this.workspace.ensure(ownerUserId);
    if (workspace instanceof Error) return workspace;
    const connection = await this.workspace.getConnection(ownerUserId);
    if (connection instanceof Error) return connection;
    if (connection === undefined)
      return new AppRequestError({ reason: "Your workspace is starting" });
    return await this.client(connection);
  }

  private async appClient(app: AppRecord) {
    const connection = await this.provider.getConnection({
      workspaceId: app.appId,
      ownerUserId: app.ownerUserId,
    });
    if (connection === undefined || connection instanceof Error)
      return connection;
    return await this.client(connection);
  }

  private async client(
    connection: Parameters<WorkspaceAuthorization["headers"]>[0],
  ) {
    const headers = await this.authorization.headers(connection);
    if (headers instanceof Error) return headers;
    return createHaloClient({
      transport: { origin: connection.origin, path: "/rpc", headers },
    });
  }

  /** Provisioning returns before the server listens; poll its RPC endpoint. */
  private async waitForApp(app: AppRecord) {
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      const client = await this.appClient(app);
      if (client !== undefined && !(client instanceof Error)) {
        const listed = await client.extensions
          .list()
          .catch(remoteFailure("probe"));
        if (!(listed instanceof Error)) return client;
      }
      if (Date.now() > deadline)
        return new AppRemoteError({ operation: "wait for app VM" });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

// The app VM's own validation messages reach the owner; other failures stay opaque.
function remoteFailure(operation: string) {
  return (cause: unknown) =>
    cause instanceof ORPCError && cause.code === "BAD_REQUEST"
      ? new AppRequestError({ reason: cause.message, cause })
      : new AppRemoteError({ operation, cause });
}

export function isAppRequestError(error: Error) {
  return error instanceof AppRequestError || error instanceof AppConflictError;
}
