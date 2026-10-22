import fs from "node:fs/promises";
import path from "node:path";
import type {
  DeviceFileEntry,
  DeviceFileOperation,
  DeviceOperationResult,
} from "@get-halo/client";
import {
  fileError,
  ioError,
  type DeviceAccess,
  type DeviceFileError,
} from "./DeviceAccess.js";

const maxListEntries = 1_000;

/**
 * Runs file operations for the workspace agent. DeviceAccess decides each
 * path first, asking the person when a folder has no grant yet.
 */
export class DeviceFiles {
  private readonly access: DeviceAccess;

  constructor(ctx: { access: DeviceAccess }) {
    this.access = ctx.access;
  }

  async run<T extends DeviceFileOperation>(
    operation: T,
  ): Promise<DeviceOperationResult[T["type"]] | DeviceFileError> {
    const target = await this.access.authorize({
      path: operation.path,
      access:
        operation.type === "files.write" || operation.type === "files.delete"
          ? "write"
          : "read",
      target: operation.type === "files.list" ? "folder" : "file",
    });
    if (target instanceof Error) return target;
    // SAFETY: Each branch returns the result type for its operation.
    return (await this.dispatch(operation, target)) as
      | DeviceOperationResult[T["type"]]
      | DeviceFileError;
  }

  private async dispatch(operation: DeviceFileOperation, target: string) {
    switch (operation.type) {
      case "files.list":
        return await this.list(target);
      case "files.stat":
        return await this.stat(target);
      case "files.read":
        return await this.read(target, operation);
      case "files.write":
        return await this.write(target, operation);
      case "files.delete":
        return await this.remove(target);
    }
  }

  private async list(target: string) {
    const entries = await fs
      .readdir(target, { withFileTypes: true })
      .catch((cause) => ioError(target, cause));
    if (entries instanceof Error) return entries;
    const listed: DeviceFileEntry[] = [];
    for (const entry of entries.slice(0, maxListEntries)) {
      const entryPath = path.join(target, entry.name);
      const info = await fs.lstat(entryPath).catch(() => undefined);
      listed.push({
        name: entry.name,
        path: entryPath,
        type: entryType(entry),
        size: info?.size ?? 0,
        modifiedAt: info?.mtimeMs ?? 0,
      });
    }
    return { path: target, entries: listed };
  }

  private async stat(
    target: string,
  ): Promise<DeviceFileEntry | DeviceFileError> {
    const info = await fs
      .lstat(target)
      .catch((cause) => ioError(target, cause));
    if (info instanceof Error) return info;
    return {
      name: path.basename(target),
      path: target,
      type: entryType(info),
      size: info.size,
      modifiedAt: info.mtimeMs,
    };
  }

  private async read(
    target: string,
    operation: Extract<DeviceFileOperation, { type: "files.read" }>,
  ) {
    const info = await fs.stat(target).catch((cause) => ioError(target, cause));
    if (info instanceof Error) return info;
    if (info.isDirectory())
      return fileError(
        "is_directory",
        `${target} is a folder; list it instead`,
      );
    if (info.size > operation.maxBytes)
      return fileError(
        "too_large",
        `${target} is ${info.size} bytes; the limit is ${operation.maxBytes}`,
      );
    const bytes = await fs
      .readFile(target)
      .catch((cause) => ioError(target, cause));
    if (bytes instanceof Error) return bytes;
    if (operation.encoding === "utf8" && bytes.includes(0))
      return fileError(
        "binary_file",
        `${target} is not a text file; copy it to the workspace instead`,
      );
    return {
      path: target,
      data: bytes.toString(operation.encoding),
      size: bytes.length,
    };
  }

  private async write(
    target: string,
    operation: Extract<DeviceFileOperation, { type: "files.write" }>,
  ) {
    const existing = await fs.stat(target).catch(() => undefined);
    if (existing?.isDirectory())
      return fileError("is_directory", `${target} is a folder`);
    const created = await fs
      .mkdir(path.dirname(target), { recursive: true })
      .catch((cause) => ioError(target, cause));
    if (created instanceof Error) return created;
    const bytes = Buffer.from(operation.data, operation.encoding);
    const written = await fs
      .writeFile(target, bytes)
      .catch((cause) => ioError(target, cause));
    if (written instanceof Error) return written;
    return { path: target, size: bytes.length };
  }

  private async remove(target: string) {
    const info = await fs
      .lstat(target)
      .catch((cause) => ioError(target, cause));
    if (info instanceof Error) return info;
    if (info.isDirectory())
      return fileError(
        "is_directory",
        `${target} is a folder; Halo deletes only files`,
      );
    const removed = await fs
      .unlink(target)
      .catch((cause) => ioError(target, cause));
    if (removed instanceof Error) return removed;
    return { path: target };
  }
}

function entryType(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): DeviceFileEntry["type"] {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}
