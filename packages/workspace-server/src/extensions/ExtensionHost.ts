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

type RunningExtension = Exclude<
  Awaited<ReturnType<typeof startExtension>>,
  Error
>;

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

  constructor(ctx: {
    workspaceRoot: string;
    toolsOrigin: string;
    filesystem: FilesystemService;
    logger: Logger;
    runtime: ExtensionRuntime;
  }) {
    const { workspaceRoot, toolsOrigin, filesystem, logger, runtime } = ctx;
    this.workspaceRoot = workspaceRoot;
    this.toolsOrigin = toolsOrigin;
    this.filesystem = filesystem;
    this.logger = logger;
    this.runtime = runtime;
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

  getOrigin(id: string) {
    const extension = this.processes.get(id);
    if (extension === undefined || !extension.isRunning()) return undefined;
    return new URL(extension.url).origin;
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
    const extension = await startExtension({
      id,
      workspaceRoot: this.workspaceRoot,
      directory: join(this.workspaceRoot, ".halo", "extensions", id),
      dataDirectory: join(this.workspaceRoot, ".halo", "extension-data", id),
      runtime: this.runtime,
      logger: this.logger,
      tools: { origin: this.toolsOrigin, token },
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
