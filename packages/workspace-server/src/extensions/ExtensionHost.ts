import { join } from "node:path";
import crypto, { randomUUID } from "node:crypto";
import type { Logger } from "@get-halo/logger";
import * as errore from "errore";
import {
  FilesystemPathNotFoundError,
  type FilesystemService,
} from "../filesystem/FilesystemService.js";
import type { ExtensionSummary } from "@get-halo/client";
import { Stream } from "@get-halo/shared/Stream";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import { readExtensionManifest } from "./readExtensionManifest.js";
import { startExtension, type ExtensionRuntime } from "./startExtension.js";
import { AppSandbox, AppSandboxError } from "./AppSandbox.js";
import { AppProject, AppProjectError } from "./AppProject.js";
import type { RemoteApps } from "./appsRouter.js";
import { AppPublication } from "./AppPublication.js";
import { DemoBusyError, DemoInstances } from "./DemoInstances.js";
import type { ExtensionArtifact } from "@get-halo/client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export type SharedAppRuntime = {
  appId: string;
  extensionId: string;
  syncAccess: "read-only" | "shared" | "actions";
  demo?: boolean;
};

type RunningExtension = {
  id: string;
  url: string;
  hostToken: string;
  isRunning(): boolean;
  stop(): Promise<void | Error>;
};

class ExtensionNotRunningError extends errore.createTaggedError({
  name: "ExtensionNotRunningError",
  message: "Extension '$id' is not running",
}) {}

class ExtensionsClosedError extends errore.createTaggedError({
  name: "ExtensionsClosedError",
  message: "Extension host is shutting down.",
  extends: errore.AbortError,
}) {}

export class ExtensionHost {
  // Publishes ordered snapshots to connected clients.
  private readonly changes = new Stream<ExtensionSummary[] | Error>();
  // Ends subscriptions when the host shuts down.
  private readonly closed = new AbortController();
  // Extension processes indexed by extension ID.
  private readonly processes = new Map<string, RunningExtension>();
  // Serializes extension process changes.
  private readonly actionQueue = new SerialQueue();
  // Maps bearer tokens to the extensions allowed to use them.
  private readonly toolTokens = new Map<string, string>();
  // Current view URLs of this workspace's published apps, by app ID. They are
  // looked up outside the queue, so a slow control plane never blocks it.
  private readonly remoteLinks = new Map<string, string>();
  // Signs viewer tokens stamped on proxied requests, so app code can act for a
  // viewer only while serving that viewer's request.
  private readonly viewerKey = crypto.randomBytes(32);

  private readonly workspaceRoot: string;
  private readonly toolsOrigin: string;
  private readonly filesystem: FilesystemService;
  private readonly logger: Logger;
  private readonly runtime: ExtensionRuntime;
  private readonly sharedApp: SharedAppRuntime | undefined;
  private readonly sandbox: AppSandbox | undefined;
  private readonly publication: AppPublication;
  private readonly remoteApps: RemoteApps | undefined;
  private readonly demo: DemoInstances | undefined;

  constructor(ctx: {
    workspaceRoot: string;
    toolsOrigin: string;
    filesystem: FilesystemService;
    logger: Logger;
    runtime: ExtensionRuntime;
    sharedApp?: SharedAppRuntime;
    remoteApps?: RemoteApps;
  }) {
    const { workspaceRoot, toolsOrigin, filesystem, logger, runtime } = ctx;
    this.workspaceRoot = workspaceRoot;
    this.toolsOrigin = toolsOrigin;
    this.filesystem = filesystem;
    this.logger = logger;
    this.runtime = runtime;
    this.sharedApp = ctx.sharedApp;
    this.remoteApps = ctx.remoteApps;
    this.sandbox =
      runtime.sandbox === undefined
        ? undefined
        : new AppSandbox(runtime.sandbox);
    this.publication = new AppPublication({ workspaceRoot });
    this.demo =
      this.sandbox === undefined ||
      ctx.sharedApp === undefined ||
      ctx.sharedApp.demo !== true
        ? undefined
        : new DemoInstances({
            sandbox: this.sandbox,
            extensionId: ctx.sharedApp.extensionId,
            brokerPort: Number(new URL(toolsOrigin).port),
            syncAccess: ctx.sharedApp.syncAccess,
          });
  }

  async refresh() {
    await this.loadRemoteLinks();
    return await this.actionQueue.run(async () => {
      const snapshot = await this.listUnqueued();
      if (snapshot instanceof Error)
        this.logger.warn({
          event: "extension-links-refresh-failed",
          error: snapshot,
        });
      this.changes.append(snapshot);
    });
  }

  async list() {
    this.refreshRemoteLinks();
    return await this.actionQueue.run(async () => await this.listUnqueued());
  }

  async *watch(signal: AbortSignal | undefined) {
    const abortSignal =
      signal === undefined
        ? this.closed.signal
        : AbortSignal.any([signal, this.closed.signal]);
    this.refreshRemoteLinks();
    const initial = await this.actionQueue.run(async () => ({
      snapshot: await this.listUnqueued(),
      // Register in the snapshot's queue turn so later changes are buffered.
      updates: this.changes.consume({ abortSignal }),
    }));
    using updates = initial.updates;
    if (abortSignal.aborted) return;
    yield initial.snapshot;
    yield* updates;
  }

  /** Looks links up without waiting; a changed link publishes a new snapshot. */
  private refreshRemoteLinks() {
    void this.loadRemoteLinks().then(
      async (changed) => {
        if (changed)
          await this.actionQueue.run(async () => await this.publishUnqueued());
      },
      // coverage-exempt: loadRemoteLinks returns its failures; this only guards an unexpected rejection.
      (cause) =>
        this.logger.warn({
          event: "extension-links-unavailable",
          error: cause,
        }),
    );
  }

  /** Refreshes published apps' current links; failures keep the last known ones. */
  private async loadRemoteLinks() {
    if (this.remoteApps === undefined) return false;
    const published = await this.publication.list();
    if (published instanceof Error) return false;
    if (!published.some((app) => app.state === "remote")) return false;
    const remote = await this.remoteApps
      .list(undefined, { signal: AbortSignal.timeout(5000) })
      .catch(
        (cause) =>
          new AppProjectError({ detail: "read published app links", cause }),
      );
    if (remote instanceof Error) {
      this.logger.warn({ event: "extension-links-unavailable", error: remote });
      return false;
    }
    let changed = false;
    for (const app of remote) {
      const url = `${app.url}view/`;
      if (this.remoteLinks.get(app.appId) === url) continue;
      this.remoteLinks.set(app.appId, url);
      changed = true;
    }
    return changed;
  }

  private async listUnqueued() {
    const workspaceRoot = this.workspaceRoot;
    const extensions: ExtensionSummary[] = [];
    for (const { id, url, isRunning } of this.processes.values()) {
      if (!isRunning()) continue;
      const manifest = await readExtensionManifest({
        filesystem: this.filesystem,
        workspaceRoot,
        id,
      });
      if (manifest instanceof Error) return manifest;
      extensions.push({
        id,
        url,
        displayName:
          manifest.halo?.displayName === undefined
            ? id
            : manifest.halo.displayName,
        icon: manifest.halo?.icon,
      });
    }
    const published = await this.publication.list();
    if (published instanceof Error) return published;
    for (const app of published) {
      if (app.state !== "remote") continue;
      const current = this.remoteLinks.get(app.appId);
      extensions.push({
        id: app.extensionId,
        url: current ?? app.url,
        displayName: app.displayName,
        remote: { appId: app.appId },
      });
    }
    return extensions;
  }

  issueViewerToken(viewerId: string) {
    const payload = `${Date.now() + 60 * 60_000}.${Buffer.from(viewerId).toString("base64url")}`;
    return `${payload}.${this.signViewer(payload)}`;
  }

  /** The viewer a token was issued for, while it is unexpired. */
  readViewerToken(token: string) {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = `${parts[0]}.${parts[1]}`;
    const expected = Buffer.from(this.signViewer(payload));
    const actual = Buffer.from(parts[2]!);
    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected) ||
      Number(parts[0]) < Date.now()
    )
      return undefined;
    return Buffer.from(parts[1]!, "base64url").toString();
  }

  private signViewer(payload: string) {
    return crypto
      .createHmac("sha256", this.viewerKey)
      .update(payload)
      .digest("base64url");
  }

  /** The backend serving one viewer: the app, or that visitor's demo instance. */
  async connectViewer(ctx: { id: string; viewerId: string }) {
    if (this.demo === undefined || !this.isSharedApp(ctx.id))
      return this.getConnection(ctx.id);
    const instance = await this.demo.connect(ctx.viewerId);
    if (instance instanceof Error) {
      if (!(instance instanceof DemoBusyError))
        this.logger.warn({ event: "demo-start-failed", error: instance });
      return instance;
    }
    return { origin: instance.origin, hostToken: instance.hostToken };
  }

  identifyToolConnection(authorization: string | undefined) {
    if (authorization === undefined) return undefined;
    if (this.demo?.identify(authorization) === true)
      return this.sharedApp!.extensionId;
    const id = this.toolTokens.get(authorization);
    if (id === undefined || !this.processes.get(id)?.isRunning())
      return undefined;
    return id;
  }

  /** Owner headers for the workspace's own browser on a running extension's direct URL. */
  ownerHeadersFor(origin: string) {
    for (const extension of this.processes.values()) {
      if (!extension.isRunning() || new URL(extension.url).origin !== origin)
        continue;
      return {
        "x-halo-extension-token": extension.hostToken,
        "x-halo-viewer-id": "owner",
        "x-halo-viewer-role": "owner",
      };
    }
  }

  isSharedApp(extensionId: string) {
    return this.sharedApp?.extensionId === extensionId;
  }

  async snapshotProject(
    extensionId: string,
    options: { data: boolean } = { data: true },
  ) {
    return await this.actionQueue.run(async () => {
      const project = this.project(extensionId);
      if (project instanceof Error) return project;
      // Source and build cannot change under a running app; only capturing
      // live data needs it stopped, so a template snapshot keeps serving.
      if (!options.data) return await project.snapshot({ contents: undefined });
      const running = this.processes.get(extensionId);
      const stopped = await running?.stop();
      if (stopped instanceof Error) return stopped;
      this.processes.delete(extensionId);
      this.removeToolConnection(extensionId);
      const captured =
        this.isSharedApp(extensionId) && this.sandbox !== undefined
          ? await this.sandbox.snapshot(extensionId)
          : undefined;
      const snapshot =
        captured instanceof Error
          ? captured
          : await project.snapshot(
              this.isSharedApp(extensionId)
                ? { contents: captured }
                : undefined,
            );
      // A failed restart must not discard the captured project.
      const restarted =
        running === undefined
          ? undefined
          : await this.startUnqueued(extensionId);
      await this.publishUnqueued();
      if (restarted instanceof Error)
        this.logger.warn({
          event: "extension-snapshot-restart-failed",
          extensionId,
          error: restarted,
        });
      return snapshot;
    });
  }

  async installProject(ctx: {
    extensionId: string;
    artifact: ExtensionArtifact;
    installId: string;
  }) {
    return await this.actionQueue.run(async () => {
      if (!this.isSharedApp(ctx.extensionId))
        return new AppProjectError({
          detail: "installation requires a dedicated app VM",
        });
      const project = this.project(ctx.extensionId);
      if (project instanceof Error) return project;
      const installed = await project.install(ctx.artifact, ctx.installId);
      if (installed instanceof Error) return installed;
      if (this.processes.get(ctx.extensionId)?.isRunning()) return;
      const started = await this.startUnqueued(ctx.extensionId);
      await this.publishUnqueued();
      return started;
    });
  }

  /** Stop the local project and keep it stopped while it is copied. */
  async freezeForPublication(ctx: { extensionId: string; appId: string }) {
    return await this.actionQueue.run(async () => {
      if (this.sharedApp !== undefined)
        return new AppProjectError({ detail: "app VMs cannot publish apps" });
      const frozen = await this.publication.freeze(ctx);
      if (frozen instanceof Error) return frozen;
      const running = this.processes.get(ctx.extensionId);
      this.processes.delete(ctx.extensionId);
      this.removeToolConnection(ctx.extensionId);
      // The marker is written and the process is gone either way; a crash or
      // forced shutdown must not report a freeze the caller would undo.
      const stopped = await running?.stop();
      if (stopped instanceof Error)
        this.logger.warn({ event: "extension-stop-failed", error: stopped });
      await this.publishUnqueued();
    });
  }

  async releasePublication(ctx: { extensionId: string; appId: string }) {
    return await this.actionQueue.run(async () => {
      const released = await this.publication.release(ctx);
      if (released instanceof Error) return released;
      if (this.processes.get(ctx.extensionId)?.isRunning()) return;
      // The extension is the owner's again even if it cannot start, for
      // example before its first build; reload reports the same way.
      const started = await this.startUnqueued(ctx.extensionId);
      if (started instanceof Error)
        this.logger.warn({ event: "extension-start-failed", error: started });
      await this.publishUnqueued();
    });
  }

  async completePublication(ctx: {
    extensionId: string;
    appId: string;
    url: string;
    displayName: string;
  }) {
    return await this.actionQueue.run(async () => {
      const completed = await this.publication.complete(ctx);
      await this.publishUnqueued();
      return completed;
    });
  }

  /** Links an app installed elsewhere, such as a template copy, by reference. */
  async addRemoteApp(ctx: {
    extensionId: string;
    appId: string;
    url: string;
    displayName: string;
  }) {
    return await this.actionQueue.run(async () => {
      if (this.sharedApp !== undefined)
        return new AppProjectError({ detail: "app VMs cannot link apps" });
      const added = await this.publication.addRemote(ctx);
      await this.publishUnqueued();
      return added;
    });
  }

  async readSource(ctx: { extensionId: string; name: string }) {
    return await this.actionQueue.run(async () => {
      if (!this.isSharedApp(ctx.extensionId))
        return new AppProjectError({
          detail: "remote editing requires a dedicated app VM",
        });
      const project = this.project(ctx.extensionId);
      if (project instanceof Error) return project;
      return await project.read(ctx.name);
    });
  }

  async writeSource(ctx: {
    extensionId: string;
    name: string;
    contents: string;
  }) {
    return await this.actionQueue.run(async () => {
      if (!this.isSharedApp(ctx.extensionId))
        return new AppProjectError({
          detail: "remote editing requires a dedicated app VM",
        });
      const project = this.project(ctx.extensionId);
      if (project instanceof Error) return project;
      return await project.write(ctx);
    });
  }

  async executeProject(ctx: { extensionId: string; command: string }) {
    return await this.actionQueue.run(async () => {
      if (!this.isSharedApp(ctx.extensionId) || this.sandbox === undefined)
        return new AppProjectError({
          detail: "remote commands require a dedicated app VM",
        });
      if (!Value.Check(Type.String({ maxLength: 8_192 }), ctx.command))
        return new AppProjectError({ detail: "invalid remote command" });
      const running = this.processes.get(ctx.extensionId);
      const stopped = await running?.stop();
      if (stopped instanceof Error) return stopped;
      this.processes.delete(ctx.extensionId);
      this.removeToolConnection(ctx.extensionId);
      const executed = await this.sandbox.execute(ctx);
      const restarted = await this.startUnqueued(ctx.extensionId);
      await this.publishUnqueued();
      // Build output explains most restart failures, so keep it.
      if (executed instanceof Error || !(restarted instanceof Error))
        return executed;
      return {
        ...executed,
        output: `${executed.output}\nThe app did not restart: ${restarted.message}`,
      };
    });
  }

  private project(extensionId: string) {
    if (
      !Value.Check(
        Type.String({ pattern: "^[a-z][a-z0-9-]{0,79}$" }),
        extensionId,
      )
    )
      return new AppProjectError({ detail: "invalid extension ID" });
    return new AppProject({ workspaceRoot: this.workspaceRoot, extensionId });
  }

  getConnection(id: string) {
    const extension = this.processes.get(id);
    if (extension === undefined || !extension.isRunning()) return undefined;
    return {
      origin: new URL(extension.url).origin,
      hostToken: extension.hostToken,
    };
  }

  async stop() {
    this.closed.abort(new ExtensionsClosedError());
    await this.demo?.stop();
    return await this.actionQueue.run(async () => {
      const processes = [...this.processes.values()];
      this.processes.clear();
      this.toolTokens.clear();
      for (const result of await Promise.all(
        processes.map(async (extension) => await extension.stop()),
      )) {
        if (result instanceof Error)
          this.logger.warn({
            event: "extension-stop-failed",
            error: result,
          });
      }
    });
  }

  async reload() {
    return await this.actionQueue.run(async () => {
      const workspaceRoot = this.workspaceRoot;
      const directory = join(workspaceRoot, ".halo", "extensions");
      const entries = await this.filesystem.listDirectory(directory);
      if (
        entries instanceof Error &&
        !(entries instanceof FilesystemPathNotFoundError)
      ) {
        this.logger.warn({
          event: "extension-discovery-failed",
          error: entries,
        });
        return;
      }
      const published = await this.publication.list();
      if (published instanceof Error) {
        this.logger.warn({
          event: "extension-discovery-failed",
          error: published,
        });
        return;
      }
      for (const app of published) {
        if (app.state !== "remote") continue;
        // Finish a cutover interrupted after its reference was persisted.
        const retired = await this.publication.retireLocalCopies(app);
        if (retired instanceof Error)
          this.logger.warn({
            event: "extension-retire-failed",
            error: retired,
          });
      }
      const publishedIds = new Set(published.map((app) => app.extensionId));
      const discovered =
        entries instanceof FilesystemPathNotFoundError
          ? []
          : entries.filter(
              (item) =>
                item.isDirectory() &&
                !publishedIds.has(item.name) &&
                (this.sharedApp === undefined ||
                  item.name === this.sharedApp.extensionId) &&
                !item.name.startsWith(".") &&
                this.filesystem.exists(
                  join(directory, item.name, "package.json"),
                ),
            );
      const ids = new Set(discovered.map((entry) => entry.name));
      for (const [id, extension] of this.processes) {
        if (ids.has(id)) continue;
        const stopped = await extension.stop();
        this.processes.delete(id);
        this.removeToolConnection(id);
        if (stopped instanceof Error)
          this.logger.warn({
            event: "extension-stop-failed",
            error: stopped,
          });
      }
      for (const entry of discovered.toSorted((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (this.processes.get(entry.name)?.isRunning()) continue;
        const started = await this.startUnqueued(entry.name);
        if (started instanceof Error) {
          this.logger.warn({
            event: "extension-start-failed",
            error: started,
          });
        }
      }
      await this.publishUnqueued();
    });
  }

  async restart(id: string) {
    return await this.actionQueue.run(async () => {
      const extension = this.processes.get(id);
      if (extension === undefined || !extension.isRunning())
        return new ExtensionNotRunningError({ id });

      const stopped = await extension.stop();
      this.processes.delete(id);
      this.removeToolConnection(id);
      if (stopped instanceof Error) {
        await this.publishUnqueued();
        return stopped;
      }

      const started = await this.startUnqueued(id);
      await this.publishUnqueued();
      return started;
    });
  }

  private async publishUnqueued() {
    this.changes.append(await this.listUnqueued());
  }

  private async startUnqueued(id: string) {
    // Demo instances start per visitor, on their first request.
    if (this.demo !== undefined) return;
    this.removeToolConnection(id);
    const token = randomUUID();
    this.toolTokens.set(`Bearer ${token}`, id);
    const hostToken = randomUUID();
    const extension = this.isSharedApp(id)
      ? this.sandbox === undefined
        ? new AppSandboxError({
            operation: "shared apps require an OS sandbox",
          })
        : await this.sandbox.start({
            extensionId: id,
            brokerPort: Number(new URL(this.toolsOrigin).port),
            toolToken: token,
            hostToken,
            syncAccess: this.sharedApp!.syncAccess,
          })
      : await startExtension({
          id,
          workspaceRoot: this.workspaceRoot,
          directory: join(this.workspaceRoot, ".halo", "extensions", id),
          dataDirectory: join(
            this.workspaceRoot,
            ".halo",
            "extension-data",
            id,
          ),
          runtime: this.runtime,
          logger: this.logger,
          tools: { origin: this.toolsOrigin, token },
          hostToken,
        });
    if (extension instanceof Error) {
      this.removeToolConnection(id);
      return extension;
    }
    this.processes.set(id, extension);
  }

  private removeToolConnection(id: string) {
    for (const [token, extensionId] of this.toolTokens) {
      if (extensionId === id) this.toolTokens.delete(token);
    }
  }
}
