import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import crypto from "node:crypto";
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

  async publisher(ctx: { ownerUserId: string; ownerEmail: string }) {
    const handle = await this.store.ensureHandle({
      userId: ctx.ownerUserId,
      email: ctx.ownerEmail,
    });
    if (handle instanceof Error) return handle;
    return {
      handle,
      origin: creatorOrigin({ publicOrigin: this.publicOrigin, handle }),
    };
  }

  async checkPublisherHandle(ctx: { ownerUserId: string; handle: string }) {
    return await this.store.checkHandle({
      userId: ctx.ownerUserId,
      handle: ctx.handle,
    });
  }

  async renamePublisher(ctx: { ownerUserId: string; handle: string }) {
    const handle = await this.store.renameHandle({
      userId: ctx.ownerUserId,
      handle: ctx.handle,
    });
    if (handle instanceof Error) return handle;
    return {
      handle,
      origin: creatorOrigin({ publicOrigin: this.publicOrigin, handle }),
    };
  }

  async list(ownerUserId: string) {
    const apps = await this.store.list(ownerUserId);
    if (apps instanceof Error) return apps;
    const summaries: AppSummary[] = [];
    for (const app of apps) {
      if (app.origin?.kind === "demo") continue;
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
      // Template demos and installed copies have no local project to
      // publish; never adopt them.
      if (created.origin !== undefined)
        return new AppRequestError({
          reason:
            created.origin.kind === "demo"
              ? "This extension ID belongs to a template demo"
              : "This extension ID belongs to an installed template copy",
        });
      // A retry may change who can visit, never which app is published.
      const app = await this.store.updateAccess({
        appId: created.appId,
        access: ctx.access,
        published: true,
      });
      if (app instanceof Error) return app;
      const live = await this.continuePublication(app);
      if (live instanceof Error) {
        // The owner sees a plain reason; the error itself stays for agents.
        const recorded = await this.store.recordPublishFailure({
          appId: app.appId,
          message: publishFailureMessage(live),
          detail: live.message.slice(0, 500),
        });
        // coverage-exempt: App database outage while recording a failure; the publish error is still returned.
        if (recorded instanceof Error) console.error(recorded);
        return live;
      }
      const cleared = await this.store.clearPublishFailure(app.appId);
      // coverage-exempt: App database outage after the app went live.
      if (cleared instanceof Error) return cleared;
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
      if (app.stage === "live" || app.stage === "removing")
        return new AppRequestError({
          reason: "To remove this app, unpublish it and run halo app remove.",
        });
      // A lost install reply leaves the copy running before `ready` is
      // recorded, so a frozen app is abandoned only if its VM lacks it.
      if (app.stage === "ready" || (await this.installedOnVm(app)))
        return new AppRequestError({
          reason:
            "It is already on its own server, so it can't be kept local. Publish again to finish.",
        });
      const owner = await this.ownerClient(app.ownerUserId);
      if (owner instanceof Error) return owner;
      return await this.abandon({ app, owner });
    });
  }

  /** Save the extension before removing its VM; each host handoff is retryable. */
  async remove(ctx: { ownerUserId: string; appId: string }) {
    return await this.serialize(ctx.ownerUserId, async () => {
      const app = await this.owned(ctx);
      if (app instanceof Error) return app;
      if (app.origin?.kind === "demo")
        return new AppRequestError({
          reason: "Template demos cannot be removed as apps",
        });
      if (app.published)
        return new AppRequestError({
          reason:
            "Unpublish this app before removing it. Run halo app unpublish first.",
        });
      if (app.stage !== "live" && app.stage !== "removing")
        return new AppRequestError({
          reason:
            "Publishing is not finished. Run halo app publish again before removing this app.",
        });
      if (this.provider.removeAppVm === undefined)
        return new AppRequestError({
          reason: "This Halo deployment cannot remove app VMs",
        });
      const removalTarget = await this.appVmRemovalTarget(app);
      if (removalTarget instanceof Error) return removalTarget;
      const removing = await this.store.beginRemoval(app.appId);
      if (removing instanceof Error) return removing;
      const owner = await this.ownerClient(app.ownerUserId);
      if (owner instanceof Error) return owner;
      const prepared = await owner.extensions
        .prepareAppRemoval({ id: app.extensionId, appId: app.appId })
        .catch(remoteFailure("check saved extension"));
      if (prepared instanceof Error) return prepared;
      if (!prepared) {
        const target = await this.appClient(app);
        if (target instanceof Error) return target;
        if (target === undefined)
          return new AppRequestError({
            reason:
              "App VM is not reachable. Run halo app remove again when it is available.",
          });
        const artifact = await target.extensions
          .snapshotForRemoval({ id: app.extensionId, appId: app.appId })
          .catch(remoteFailure("save hosted extension"));
        if (artifact instanceof Error) return artifact;
        const saved = await owner.extensions
          .prepareAppRemoval({
            id: app.extensionId,
            appId: app.appId,
            artifact,
          })
          .catch(remoteFailure("save extension in workspace"));
        if (saved instanceof Error) return saved;
      }
      const removed = await this.provider.removeAppVm(removalTarget);
      if (removed instanceof Error) return removed;
      const cleaned = await owner.extensions
        .completeAppRemoval({ id: app.extensionId, appId: app.appId })
        .catch(remoteFailure("restore local extension"));
      if (cleaned instanceof Error) return cleaned;
      return await this.store.delete(app.appId);
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
    // Demos never reach anyone's connections; they replay the sample result
    // without spending the action budget. Their code is the author's, which
    // may still pass the author's fixed arguments that the demo dropped.
    if (ctx.app.origin?.kind === "demo")
      return {
        status: "completed" as const,
        // oxlint-disable-next-line unicorn/no-null -- A missing sample result is JSON null.
        result: action.sampleResult ?? null,
      };
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

  /**
   * Publishes a live app as a template: its source, assets and build with the
   * package's sample data, never live data or the owner's fixed arguments.
   * The demo runs on its own VM, one instance per visitor.
   */
  async publishTemplate(ctx: {
    ownerUserId: string;
    appId: string;
    slug: string;
    description: string;
  }) {
    // The demo's path is demo-<slug>, and app paths have at most 63 characters.
    if (ctx.slug.length > 58)
      return new AppRequestError({
        reason: "Template names can have at most 58 characters",
      });
    // demo-<slug> paths belong to demos, so a template name cannot start so.
    if (ctx.slug.startsWith("demo-"))
      return new AppRequestError({
        reason: "Template names cannot start with demo-",
      });
    return await this.serialize(ctx.ownerUserId, async () => {
      const app = await this.owned(ctx);
      if (app instanceof Error) return app;
      if (app.stage !== "live" || app.origin !== undefined)
        return new AppRequestError({
          reason: "Only your own live apps can become templates",
        });
      const existing = await this.store.findTemplate(ctx.slug);
      if (existing instanceof Error) return existing;
      // Only a retry of the same app's publication may continue a template.
      if (
        existing !== undefined &&
        (existing.ownerUserId !== ctx.ownerUserId ||
          existing.sourceAppId !== ctx.appId)
      )
        return new AppRequestError({
          reason: "Another template already uses this name",
        });
      const template = existing ?? (await this.createTemplate({ ...ctx, app }));
      if (template instanceof Error) return template;
      const demo = await this.store.get(template.demoAppId);
      if (demo instanceof Error) return demo;
      // coverage-exempt: Demo records are never deleted once a template names them.
      if (demo === undefined)
        return new AppRequestError({ reason: "Template demo is missing" });
      const artifact = errore.try({
        // SAFETY: Written by createTemplate from a validated artifact.
        try: () => JSON.parse(template.artifact) as ExtensionArtifact,
        catch: (cause) =>
          new AppRequestError({ reason: "Template is unreadable", cause }), // coverage-exempt: Stored templates are written only by createTemplate as JSON.
      });
      if (artifact instanceof Error) return artifact;
      // The stored artifact, not a new snapshot, so a retry installs the same code.
      const live = await this.continueCopy({ app: demo, artifact });
      if (live instanceof Error) return live;
      const ready = await this.store.markTemplateReady(template.templateId);
      if (ready instanceof Error) return ready;
      return this.templateSummary(template);
    });
  }

  /** Stores a new template and its demo record; nothing is provisioned yet. */
  private async createTemplate(ctx: {
    app: AppRecord;
    slug: string;
    description: string;
  }) {
    const { app } = ctx;
    const source = await this.appClient(app);
    if (source instanceof Error) return source;
    if (source === undefined)
      return new AppRequestError({ reason: "App VM is not reachable" });
    const snapshot = await source.extensions
      .snapshot({ id: app.extensionId, data: false })
      .catch(remoteFailure("snapshot"));
    if (snapshot instanceof Error) return snapshot;
    const artifact = templateArtifact(snapshot);
    if (artifact instanceof Error) return artifact;
    const demo = await this.store.create({
      ownerUserId: app.ownerUserId,
      extensionId: `demo-${ctx.slug}`,
      slug: `demo-${ctx.slug}`,
      displayName: app.displayName,
      visibility: "public",
      members: [],
      syncAccess: app.syncAccess,
      actions: [],
      origin: { kind: "demo", templateId: crypto.randomUUID() },
    });
    if (demo instanceof Error) return demo;
    // An existing record is adopted only if it is an unprovisioned demo: one
    // left by an attempt that stopped before storing its template.
    if (demo.origin?.kind !== "demo" || demo.stage !== "frozen")
      return new AppRequestError({
        reason: `Another app already uses demo-${ctx.slug}`,
      });
    const created = await this.store.createTemplate({
      templateId: demo.origin.templateId,
      ownerUserId: app.ownerUserId,
      sourceAppId: app.appId,
      slug: ctx.slug,
      displayName: app.displayName,
      description: ctx.description,
      artifact: JSON.stringify(artifact),
      demoAppId: demo.appId,
    });
    if (created instanceof Error) return created;
    const template = await this.store.findTemplate(ctx.slug);
    if (template instanceof Error) return template;
    // coverage-exempt: The row was stored by this call under the owner's queue.
    if (template === undefined)
      return new AppRequestError({ reason: "Template was not stored" });
    return template;
  }

  /** Installs a template as a new private app on the recipient's own VM. */
  async installTemplate(ctx: {
    ownerUserId: string;
    ownerEmail: string;
    slug: string;
  }) {
    if (this.provider.hostsSharedApps !== true)
      return new AppRequestError({
        reason: "This Halo deployment cannot host shared apps",
      });
    return await this.serialize(ctx.ownerUserId, async () => {
      const template = await this.store.findTemplate(ctx.slug);
      if (template instanceof Error) return template;
      // coverage-exempt: Templates are never deleted and the install route looks them up first.
      if (template === undefined || !template.ready)
        return new AppRequestError({ reason: "Template not found" });
      const artifact = errore.try({
        // SAFETY: Written only by publishTemplate from a validated artifact.
        try: () => JSON.parse(template.artifact) as ExtensionArtifact,
        catch: (cause) =>
          new AppRequestError({ reason: "Template is unreadable", cause }), // coverage-exempt: Stored templates are written only by publishTemplate as JSON.
      });
      if (artifact instanceof Error) return artifact;
      const handle = await this.store.ensureHandle({
        userId: ctx.ownerUserId,
        email: ctx.ownerEmail,
      });
      if (handle instanceof Error) return handle;
      const app = await this.store.create({
        ownerUserId: ctx.ownerUserId,
        extensionId: template.slug,
        slug: template.slug,
        displayName: template.displayName,
        visibility: "invited",
        members: [],
        published: false,
        syncAccess: "read-only",
        actions: [],
        origin: { kind: "template", templateId: template.templateId },
      });
      if (app instanceof Error) return app;
      if (app.origin?.templateId !== template.templateId)
        return new AppRequestError({
          reason: `You already have an app named ${template.slug}`,
        });
      const live = await this.continueCopy({ app, artifact });
      if (live instanceof Error) return live;
      return await this.summarize(live);
    });
  }

  /** Demos and installed copies: install, build, then reference; resumable. */
  private async continueCopy(ctx: {
    app: AppRecord;
    artifact: ExtensionArtifact;
  }) {
    const demo = ctx.app.origin?.kind === "demo";
    const ready =
      ctx.app.stage === "frozen"
        ? await (async () => {
            // Refuse a name the recipient already uses before provisioning.
            if (!demo) {
              const owner = await this.ownerClient(ctx.app.ownerUserId);
              if (owner instanceof Error) return owner;
              const existing = await owner.extensions
                .list()
                .catch(remoteFailure("list extensions"));
              if (existing instanceof Error) return existing;
              if (
                existing.some(
                  (extension) =>
                    extension.id === ctx.app.extensionId &&
                    extension.remote?.appId !== ctx.app.appId,
                )
              )
                return new AppRequestError({
                  reason: `You already have an extension named ${ctx.app.extensionId}`,
                });
            }
            const defined = await this.define({
              app: ctx.app,
              artifact: ctx.artifact,
              actions: demo ? "samples" : "none",
            });
            if (defined instanceof Error) return defined;
            const target = await this.provisionAndInstall({
              app: defined,
              artifact: ctx.artifact,
            });
            if (target instanceof Error) return target;
            // The template's compiled output is replaced by a build in the
            // copy's own build sandbox, with no access to anyone's secrets.
            // `npm install`, not `npm ci`: the sandbox points the Halo SDK
            // dependencies at its bundled packages before running commands.
            if (!demo) {
              const built = await target.extensions
                .execSource({
                  id: defined.extensionId,
                  command: "npm install --no-audit --no-fund && npm run build",
                })
                .catch(remoteFailure("build"));
              if (built instanceof Error) return built;
              if (built.exitCode !== 0)
                return new AppRequestError({
                  reason: `The template did not build: ${built.output.slice(-500)}`,
                });
            }
            return await this.store.advance({
              appId: defined.appId,
              from: "frozen",
              to: "ready",
            });
          })()
        : ctx.app;
    if (ready instanceof Error) return ready;
    if (ready.stage !== "ready") return ready;
    if (!demo) {
      const owner = await this.ownerClient(ready.ownerUserId);
      if (owner instanceof Error) return owner;
      const referenced = await owner.extensions
        .addRemote({
          id: ready.extensionId,
          appId: ready.appId,
          url: `${this.url(ready)}view/`,
          displayName: ready.displayName,
        })
        .catch(remoteFailure("store reference"));
      // A local project the name check could not see (one that is not
      // running) keeps the name; abandon the copy instead of leaving it.
      if (referenced instanceof AppRequestError) {
        const removalTarget = await this.appVmRemovalTarget(ready);
        if (removalTarget instanceof Error) return removalTarget;
        const removed = await this.provider.removeAppVm?.(removalTarget);
        if (removed instanceof Error) return removed;
        const deleted = await this.store.delete(ready.appId);
        if (deleted instanceof Error) return deleted;
        return new AppRequestError({
          reason: `You already have an extension named ${ready.extensionId}`,
        });
      }
      if (referenced instanceof Error) return referenced;
    }
    return await this.store.advance({
      appId: ready.appId,
      from: "ready",
      to: "live",
    });
  }

  private templateSummary(template: {
    slug: string;
    handle: string;
    displayName: string;
    description: string;
  }) {
    return {
      slug: template.slug,
      displayName: template.displayName,
      description: template.description,
      url: new URL(`/templates/${template.slug}`, this.publicOrigin).toString(),
      demoUrl: `${creatorOrigin({ publicOrigin: this.publicOrigin, handle: template.handle })}/demo-${template.slug}/view/`,
    };
  }

  /** Verifies an app VM's own runtime token; it never grants owner authority. */
  async authenticateRuntime(authorization: string | undefined) {
    const claimed = this.credentials.read(authorization);
    if (claimed === undefined) return undefined;
    const app = await this.store.get(claimed.appId);
    if (app instanceof Error) return app;
    if (
      app === undefined ||
      app.stage === "removing" ||
      app.credentialGeneration !== claimed.generation
    )
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
    const installed = await this.provisionAndInstall({
      app: defined,
      artifact,
    });
    if (installed instanceof Error) return installed;
    return await this.store.advance({
      appId: defined.appId,
      from: "frozen",
      to: "ready",
    });
  }

  /** Provisions the app's own VM and installs the copy once. */
  private async provisionAndInstall(ctx: {
    app: AppRecord;
    artifact: ExtensionArtifact;
  }) {
    const { app } = ctx;
    const sharedApp: NonNullable<
      Parameters<WorkspaceProviderApi["ensure"]>[0]["sharedApp"]
    > = {
      appId: app.appId,
      extensionId: app.extensionId,
      syncAccess: app.syncAccess,
    };
    if (app.origin?.kind === "demo") sharedApp.demo = true;
    const provisioned = await this.provider.ensure({
      workspaceId: app.appId,
      ownerUserId: app.ownerUserId,
      runtime: {
        origin: this.publicOrigin,
        workspaceId: app.appId,
        token: this.credentials.issue({
          appId: app.appId,
          generation: app.credentialGeneration,
        }),
        generation: app.credentialGeneration,
      },
      sharedApp,
    });
    if (provisioned instanceof Error) return provisioned;
    const target = await this.waitForApp(app);
    if (target instanceof Error) return target;
    const installed = await target.extensions
      .install({
        id: app.extensionId,
        artifact: ctx.artifact,
        installId: app.installId,
      })
      .catch(remoteFailure("install"));
    if (installed instanceof Error) return installed;
    return target;
  }

  /** Reads the app definition from the frozen package, with safe defaults. */
  private async define(ctx: {
    app: AppRecord;
    artifact: ExtensionArtifact;
    // Owner apps bind checked requests; demos keep only sample results;
    // installed copies start unbound until their new owner binds actions.
    actions?: "owner" | "samples" | "none";
  }) {
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
    const mode = ctx.actions ?? "owner";
    const actions =
      mode === "owner"
        ? await this.validateActions({
            ownerUserId: ctx.app.ownerUserId,
            actions: definition.actions,
          })
        : mode === "samples"
          ? definition.actions.map((action) => ({ ...action, arguments: {} }))
          : [];
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

  /** Only server-loaded app records may reach the destructive provider operation. */
  private async appVmRemovalTarget(app: AppRecord) {
    const isWorkspace = await this.workspace.hasWorkspace(app.appId);
    if (isWorkspace instanceof Error) return isWorkspace;
    if (isWorkspace)
      return new AppRequestError({
        reason:
          "Main workspaces cannot be removed as apps. Use halo app list to choose a published app.",
      });
    return { appId: app.appId, ownerUserId: app.ownerUserId };
  }

  /** Restarts the frozen local project and forgets the publication. */
  private async abandon(ctx: { app: AppRecord; owner: HaloClient }) {
    // Delete the app VM first, so it can never receive the copy later.
    const removalTarget = await this.appVmRemovalTarget(ctx.app);
    if (removalTarget instanceof Error) return removalTarget;
    const removed = await this.provider.removeAppVm?.(removalTarget);
    if (removed instanceof Error) return removed;
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
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => {
      entry.pending -= 1;
      if (entry.pending === 0) this.publications.delete(ownerUserId);
    });
    return await entry.queue.run(run);
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
    if (app.stage === "removing")
      return new AppRequestError({
        reason: "App is being removed. Run halo app remove again to finish.",
      });
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
    const summary: AppSummary = {
      appId: app.appId,
      extensionId: app.extensionId,
      displayName: app.displayName,
      handle: app.handle,
      slug: app.slug,
      url: this.url(app),
      visibility: app.visibility,
      members: app.members,
      published: app.published,
      stage:
        app.stage === "removing"
          ? "removing"
          : app.stage === "live"
            ? "live"
            : "publishing",
      actions: actions.map((action) => ({
        name: action.name,
        description: action.description,
      })),
    };
    if (app.stage !== "live" && app.publishFailure !== undefined)
      summary.publishFailure = app.publishFailure;
    return summary;
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
  /**
   * Whether the app's VM answers with its project. A VM that does not answer
   * serves no visitor; abandoning the publication deletes it.
   */
  private async installedOnVm(app: AppRecord) {
    const client = await this.appClient(app);
    if (client === undefined || client instanceof Error) return false;
    const listed = await client.extensions.list().catch(remoteFailure("probe"));
    if (listed instanceof Error) return false;
    return listed.some((extension) => extension.id === app.extensionId);
  }

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

/** Why publishing stopped, in words for the owner rather than host details. */
function publishFailureMessage(error: Error) {
  // The app VM reports a failed start as a refused request.
  if (error.message.includes("App sandbox failed: start"))
    return "Its new server could not start the app.";
  if (isAppRequestError(error)) return error.message;
  return "Something went wrong while moving it to its own server.";
}

export function isAppRequestError(error: Error) {
  return error instanceof AppRequestError || error instanceof AppConflictError;
}

/**
 * A template carries the app's files and build with sample data from
 * `sample-data.json`, and drops the owner's fixed action arguments, which
 * name the owner's own resources.
 */
function templateArtifact(snapshot: ExtensionArtifact) {
  const manifest = errore.try({
    // SAFETY: Only the halo.app.actions shape is changed; the rest is kept.
    try: () =>
      JSON.parse(snapshot.files["package.json"] ?? "") as {
        halo?: { app?: { actions?: { arguments?: unknown }[] } };
      },
    catch: (cause) =>
      new AppRequestError({ reason: "package.json is invalid", cause }),
  });
  if (manifest instanceof Error) return manifest;
  for (const action of manifest.halo?.app?.actions ?? []) action.arguments = {};
  const sample = snapshot.files["sample-data.json"];
  const sampleData =
    sample === undefined
      ? undefined
      : errore.try({
          try: () => JSON.stringify(JSON.parse(sample)),
          catch: (cause) =>
            new AppRequestError({
              reason: "sample-data.json is not JSON",
              cause,
            }),
        });
  if (sampleData instanceof Error) return sampleData;
  return {
    files: {
      ...snapshot.files,
      "package.json": `${JSON.stringify(manifest, undefined, 2)}\n`,
    },
    assets: snapshot.assets,
    build: snapshot.build,
    data: sampleData,
  } satisfies ExtensionArtifact;
}
