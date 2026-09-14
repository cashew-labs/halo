import { basename, dirname, join, relative, resolve, sep } from "node:path";
import * as errore from "errore";
import type { WorkspaceInfo, WorkspaceTreeEvent } from "@get-halo/shared/rpc";
import { type ReadonlyStream, Stream } from "@get-halo/shared/Stream";
import {
  type FilesystemWatchBatch,
  type FilesystemWatchEvent,
  FilesystemService,
  FilesystemPathNotFoundError,
} from "../filesystem/FilesystemService.js";
import { workspaceFilePreview } from "./workspaceFilePreview.js";
import { installHaloCli } from "./installHaloCli.js";
import { seedExtensionWorkspace } from "../extensions/seedExtensionWorkspace.js";

export type WorkspaceLayout = {
  readonly root: string;
  readonly agentDir: string;
};

export class WorkspaceNotDirectoryError extends errore.createTaggedError({
  name: "WorkspaceNotDirectoryError",
  message: "The selected workspace must be a directory.",
}) {}

export class WorkspaceIoError extends errore.createTaggedError({
  name: "WorkspaceIoError",
  message: "Workspace I/O failed",
}) {}

export class WorkspaceInvalidPathError extends errore.createTaggedError({
  name: "WorkspaceInvalidPathError",
  message: "'$path' is not a workspace file.",
}) {}

export class WorkspaceEntryExistsError extends errore.createTaggedError({
  name: "WorkspaceEntryExistsError",
  message: "An item named '$entryName' already exists in this folder.",
}) {}

export class WorkspaceInvalidMoveError extends errore.createTaggedError({
  name: "WorkspaceInvalidMoveError",
  message: "A folder cannot be moved into itself.",
}) {}

/** Finder-hidden names (leading `.`) plus `node_modules` for walk cost. */
function shouldSkipEntryName(name: string): boolean {
  if (name.startsWith(".")) return true;
  return name === "node_modules";
}

function isSkippedRelativePath(relativePath: string): boolean {
  for (const segment of relativePath.split("/")) {
    if (segment.length === 0) continue;
    if (shouldSkipEntryName(segment)) return true;
  }
  return false;
}

function toPosixRelative(
  workspaceRoot: string,
  absolutePath: string,
): string | undefined {
  const rel = relative(workspaceRoot, absolutePath);
  if (rel.length === 0) return undefined;
  if (rel === "..") return undefined;
  if (rel.startsWith(`..${sep}`)) return undefined;
  return rel.split(sep).join("/");
}

function mapFilesystemEventsToTreeEvents(
  workspaceRoot: string,
  events: readonly FilesystemWatchEvent[],
  directoryPaths: Set<string>,
) {
  const mapped: WorkspaceTreeEvent[] = [];

  for (const event of events) {
    if (event.type === "update") continue;

    const relativePath = toPosixRelative(workspaceRoot, event.path);
    if (relativePath === undefined) continue;
    if (isSkippedRelativePath(relativePath)) continue;

    if (event.type === "delete") {
      const directoryPath = relativePath.endsWith("/")
        ? relativePath
        : `${relativePath}/`;
      if (directoryPaths.has(directoryPath)) {
        mapped.push({ type: "delete", path: directoryPath });
        removeDirectoryAndDescendants(directoryPaths, directoryPath);
        continue;
      }
      mapped.push({ type: "delete", path: relativePath });
      continue;
    }

    if (event.kind === "directory") {
      const directoryPath = relativePath.endsWith("/")
        ? relativePath
        : `${relativePath}/`;
      directoryPaths.add(directoryPath);
      mapped.push({ type: "create", path: directoryPath });
      continue;
    }
    mapped.push({ type: "create", path: relativePath });
  }

  return mapped;
}

function directoryPathsFromList(paths: readonly string[]): Set<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    if (path.endsWith("/")) directories.add(path);
  }
  return directories;
}

function removeDirectoryAndDescendants(
  directoryPaths: Set<string>,
  directoryPath: string,
) {
  for (const known of Array.from(directoryPaths)) {
    if (known === directoryPath || known.startsWith(directoryPath)) {
      directoryPaths.delete(known);
    }
  }
}

type WorkspaceServiceOptions = {
  workspaceRoot: string;
  appDataDir: string;
  filesystem: FilesystemService;
  appVersion: string;
  cliEntry?: string;
  cliNodeExecutable?: string;
  cliElectronRunAsNode?: boolean;
};

export class WorkspaceService {
  readonly layout: WorkspaceLayout;
  private readonly treeEventStream = new Stream<WorkspaceTreeEvent[]>();
  readonly treeEvents: ReadonlyStream<WorkspaceTreeEvent[]> =
    this.treeEventStream;
  private readonly unsubscribeFilesystemEvents: () => void;
  private directoryPaths = new Set<string>();

  static async create(options: WorkspaceServiceOptions) {
    const root = resolve(options.workspaceRoot);
    const metadata = await options.filesystem.stat(root);
    if (metadata instanceof Error)
      return new WorkspaceIoError({ cause: metadata });
    if (!metadata.isDirectory()) return new WorkspaceNotDirectoryError();
    return new WorkspaceService({ ...options, workspaceRoot: root });
  }

  private constructor(private readonly options: WorkspaceServiceOptions) {
    this.layout = workspaceLayout(options.workspaceRoot);
    const watchEvents = this.options.filesystem.watchEvents.filter(
      (entry): entry is FilesystemWatchBatch => {
        if (entry.watchedPath !== this.layout.root) return false;
        if (entry instanceof Error) {
          console.warn("Workspace watch failed:", entry.message);
          return false;
        }
        return true;
      },
    );
    this.unsubscribeFilesystemEvents = watchEvents.subscribe((batch) => {
      this.handleWatchEvents(batch);
    });
  }

  getWorkspace(): WorkspaceInfo {
    return workspaceInfo(this.layout);
  }

  async listPaths() {
    const layout = this.layout;
    const paths = await listRelativeWorkspacePaths(
      this.options.filesystem,
      layout.root,
    );
    if (paths instanceof Error) return paths;
    this.directoryPaths = directoryPathsFromList(paths);
    return paths;
  }

  async previewFile(path: string) {
    const absolutePath = await this.resolveEntryPath(path);
    if (absolutePath instanceof Error) return absolutePath;
    const metadata = await this.options.filesystem.lstat(absolutePath);
    if (metadata instanceof Error)
      return new WorkspaceIoError({ cause: metadata });
    if (!metadata.isFile()) return new WorkspaceInvalidPathError({ path });
    if (metadata.size > 100 * 1024 * 1024) {
      return {
        kind: "unsupported" as const,
        reason: "Files larger than 100 MB can be opened in their default app.",
      };
    }
    const contents = await this.options.filesystem.readFile(absolutePath);
    if (contents instanceof Error)
      return new WorkspaceIoError({ cause: contents });
    return workspaceFilePreview(path, contents);
  }

  async readFile(path: string) {
    const layout = this.layout;

    const absolutePath = resolve(layout.root, path);
    const relativePath = toPosixRelative(layout.root, absolutePath);
    if (relativePath !== path || isSkippedRelativePath(path)) {
      return new WorkspaceInvalidPathError({ path });
    }

    const contents = await this.options.filesystem.readFile(
      absolutePath,
      "utf8",
    );
    if (contents instanceof Error)
      return new WorkspaceIoError({ cause: contents });
    return contents;
  }

  async writeFile(path: string, content: string) {
    const layout = this.layout;

    const absolutePath = resolve(layout.root, path);
    const relativePath = toPosixRelative(layout.root, absolutePath);
    if (relativePath !== path || isSkippedRelativePath(path)) {
      return new WorkspaceInvalidPathError({ path });
    }

    const directoryCreated = await this.options.filesystem.makeDirectory(
      dirname(absolutePath),
      { recursive: true },
    );
    if (directoryCreated instanceof Error) {
      return new WorkspaceIoError({ cause: directoryCreated });
    }

    const written = await this.options.filesystem.writeFile(
      absolutePath,
      content,
      "utf8",
    );
    if (written instanceof Error)
      return new WorkspaceIoError({ cause: written });
    return { path };
  }

  async createEntry(input: { path: string; kind: "file" | "directory" }) {
    const path = await this.resolveEntryPath(input.path);
    if (path instanceof Error) return path;
    const available = await this.checkAvailable(path);
    if (available instanceof Error) return available;
    const created =
      input.kind === "directory"
        ? await this.options.filesystem.makeDirectory(path)
        : await this.options.filesystem.writeFile(path, "", { flag: "wx" });
    if (created instanceof Error)
      return new WorkspaceIoError({ cause: created });
    return { path: input.path };
  }

  async moveEntry(input: { source: string; destination: string }) {
    const source = await this.resolveEntryPath(input.source);
    if (source instanceof Error) return source;
    const destination = await this.resolveEntryPath(input.destination);
    if (destination instanceof Error) return destination;
    if (destination === source || destination.startsWith(`${source}${sep}`)) {
      return new WorkspaceInvalidMoveError();
    }
    const available = await this.checkAvailable(destination, source);
    if (available instanceof Error) return available;
    const moved = await this.options.filesystem.rename(source, destination);
    if (moved instanceof Error) return new WorkspaceIoError({ cause: moved });
    return { path: input.destination };
  }

  async deleteEntry(input: { path: string }) {
    const path = await this.resolveEntryPath(input.path);
    if (path instanceof Error) return path;
    const removed = await this.options.filesystem.remove(path, {
      recursive: true,
    });
    if (removed instanceof Error)
      return new WorkspaceIoError({ cause: removed });
    return { path: input.path };
  }

  private async resolveEntryPath(path: string) {
    const absolutePath = resolve(this.layout.root, path);
    if (
      toPosixRelative(this.layout.root, absolutePath) !== path ||
      isSkippedRelativePath(path)
    ) {
      return new WorkspaceInvalidPathError({ path });
    }
    const parent = await this.options.filesystem.realpath(
      dirname(absolutePath),
    );
    if (parent instanceof Error) return new WorkspaceIoError({ cause: parent });
    const root = await this.options.filesystem.realpath(this.layout.root);
    if (root instanceof Error) return new WorkspaceIoError({ cause: root });
    if (parent !== root && toPosixRelative(root, parent) === undefined) {
      return new WorkspaceInvalidPathError({ path });
    }
    return absolutePath;
  }

  private async checkAvailable(path: string, source?: string) {
    const existing = await this.options.filesystem.lstat(path);
    if (existing instanceof FilesystemPathNotFoundError) return;
    if (existing instanceof Error)
      return new WorkspaceIoError({ cause: existing });
    if (source !== undefined && source.toLowerCase() === path.toLowerCase()) {
      const original = await this.options.filesystem.lstat(source);
      if (original instanceof Error)
        return new WorkspaceIoError({ cause: original });
      if (original.dev === existing.dev && original.ino === existing.ino)
        return;
    }
    return new WorkspaceEntryExistsError({ entryName: basename(path) });
  }

  async initialize() {
    const layout = this.layout;
    const root = layout.root;
    const seeded = await seedExtensionWorkspace(
      this.options.filesystem,
      layout,
    );
    if (seeded instanceof Error) return seeded;

    if (this.options.cliEntry !== undefined) {
      const installed = await installHaloCli({
        filesystem: this.options.filesystem,
        workspaceRoot: root,
        appVersion: this.options.appVersion,
        appDataDir: this.options.appDataDir,
        cliEntry: this.options.cliEntry,
        nodeExecutable: this.options.cliNodeExecutable,
        electronRunAsNode: this.options.cliElectronRunAsNode,
      });
      if (installed instanceof Error) return installed;
    }
    const watched = await this.options.filesystem.watch(layout.root);
    if (watched instanceof Error) {
      console.warn("Workspace watch failed to start:", watched.message);
    }
  }

  close() {
    this.unsubscribeFilesystemEvents();
  }

  private handleWatchEvents(batch: FilesystemWatchBatch) {
    const mapped = mapFilesystemEventsToTreeEvents(
      batch.watchedPath,
      batch.events,
      this.directoryPaths,
    );
    if (mapped.length === 0) return;
    this.treeEventStream.append(mapped);
  }
}

async function listRelativeWorkspacePaths(
  filesystem: FilesystemService,
  workspaceRoot: string,
) {
  const paths: string[] = [];
  const walked = await walkDirectory(filesystem, workspaceRoot, "", paths);
  if (walked instanceof Error) return walked;
  return paths;
}

async function walkDirectory(
  filesystem: FilesystemService,
  absoluteDir: string,
  relativeDir: string,
  paths: string[],
): Promise<void | WorkspaceIoError> {
  const entries = await filesystem.listDirectory(absoluteDir);
  if (entries instanceof Error) return new WorkspaceIoError({ cause: entries });

  const included = entries.filter((entry) => {
    if (shouldSkipEntryName(entry.name)) return false;
    if (entry.isSymbolicLink()) return false;
    return entry.isFile() || entry.isDirectory();
  });

  if (relativeDir.length > 0 && included.length === 0) {
    paths.push(`${relativeDir}/`);
    return;
  }

  for (const entry of included) {
    const childAbsolute = join(absoluteDir, entry.name);
    const childRelative =
      relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      const walked: void | WorkspaceIoError = await walkDirectory(
        filesystem,
        childAbsolute,
        childRelative,
        paths,
      );
      if (walked instanceof Error) return walked;
      continue;
    }
    paths.push(childRelative);
  }
}

function workspaceLayout(root: string): WorkspaceLayout {
  const agentDir = join(root, ".pi", "agent");
  return {
    root,
    agentDir,
  };
}

function workspaceInfo(layout: WorkspaceLayout): WorkspaceInfo {
  return {
    name: basename(layout.root),
    workspaceRoot: layout.root,
  };
}
