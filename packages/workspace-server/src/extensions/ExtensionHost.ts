import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
import type { ExtensionArtifact } from "@get-halo/client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export type SharedAppRuntime = {
  appId: string;
  extensionId: string;
  syncAccess: "read-only" | "shared" | "actions";
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

  private readonly workspaceRoot: string;
  private readonly toolsOrigin: string;
  private readonly filesystem: FilesystemService;
  private readonly logger: Logger;
  private readonly runtime: ExtensionRuntime;
  private readonly sharedApp: SharedAppRuntime | undefined;
  private readonly sandbox: AppSandbox | undefined;

  constructor(ctx: {
    workspaceRoot: string;
    toolsOrigin: string;
    filesystem: FilesystemService;
    logger: Logger;
    runtime: ExtensionRuntime;
    sharedApp?: SharedAppRuntime;
  }) {
    const { workspaceRoot, toolsOrigin, filesystem, logger, runtime } = ctx;
    this.workspaceRoot = workspaceRoot;
    this.toolsOrigin = toolsOrigin;
    this.filesystem = filesystem;
    this.logger = logger;
    this.runtime = runtime;
    this.sharedApp = ctx.sharedApp;
    this.sandbox =
      runtime.sandbox === undefined
        ? undefined
        : new AppSandbox(runtime.sandbox);
  }

  async list() {
    return await this.actionQueue.run(async () => await this.listUnqueued());
  }

  async *watch(signal: AbortSignal | undefined) {
    const abortSignal =
      signal === undefined
        ? this.closed.signal
        : AbortSignal.any([signal, this.closed.signal]);
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
    return extensions;
  }

  identifyToolConnection(authorization: string | undefined) {
    if (authorization === undefined) return undefined;
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

  async snapshotProject(extensionId: string) {
    return await this.actionQueue.run(async () => {
      const project = this.project(extensionId);
      if (project instanceof Error) return project;
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
      if (running !== undefined) {
        const restarted = await this.startUnqueued(extensionId);
        if (restarted instanceof Error) {
          await this.publishUnqueued();
          return restarted;
        }
      }
      await this.publishUnqueued();
      return snapshot;
    });
  }

  async installProject(ctx: {
    extensionId: string;
    artifact: ExtensionArtifact;
  }) {
    return await this.actionQueue.run(async () => {
      if (!this.isSharedApp(ctx.extensionId))
        return new AppProjectError({
          detail: "installation requires a dedicated app VM",
        });
      const project = this.project(ctx.extensionId);
      if (project instanceof Error) return project;
      const installed = await project.install(ctx.artifact);
      if (installed instanceof Error) return installed;
      const started = await this.startUnqueued(ctx.extensionId);
      await this.publishUnqueued();
      return started;
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
      if (restarted instanceof Error) return restarted;
      return executed;
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
      const discovered =
        entries instanceof FilesystemPathNotFoundError
          ? []
          : entries.filter(
              (item) =>
                item.isDirectory() &&
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
