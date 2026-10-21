import fs from "node:fs/promises";
import path from "node:path";
import * as errore from "errore";
import type {
  DeviceFileAccess,
  DeviceFileEntry,
  DeviceOperation,
  DeviceOperationResult,
} from "@get-halo/client";

export type DeviceFileErrorCode =
  | "files_disabled"
  | "read_only"
  | "outside_allowed_folders"
  | "protected_path"
  | "not_found"
  | "is_directory"
  | "not_a_directory"
  | "too_large"
  | "binary_file"
  | "io_error";

export class DeviceFileError extends errore.createTaggedError({
  name: "DeviceFileError",
  message: "$detail ($code)",
}) {}

function fileError(code: DeviceFileErrorCode, detail: string, cause?: unknown) {
  return new DeviceFileError({ code, detail, cause });
}

/** Paths under the home folder that hold credentials; never served. */
const protectedHomePaths = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".config/gcloud",
  "Library/Keychains",
  "Library/Cookies",
];

const maxListEntries = 1_000;

export type DeviceFilePolicy = {
  access: DeviceFileAccess;
  roots: readonly string[];
  home: string;
};

/**
 * Runs file operations for the workspace agent inside the folders the person
 * chose. The device enforces these settings; the workspace cannot widen them.
 */
export class DeviceFiles {
  private readonly policy: DeviceFilePolicy;

  constructor(policy: DeviceFilePolicy) {
    this.policy = policy;
  }

  async run<T extends DeviceOperation>(
    operation: T,
  ): Promise<DeviceOperationResult[T["type"]] | DeviceFileError> {
    const writes =
      operation.type === "files.write" || operation.type === "files.delete";
    if (this.policy.access === "off")
      return fileError(
        "files_disabled",
        "File access is turned off for this computer in Halo",
      );
    if (writes && this.policy.access !== "write")
      return fileError(
        "read_only",
        "This computer allows Halo to read files but not change them",
      );
    const target = await this.authorize(operation.path);
    if (target instanceof Error) return target;
    // SAFETY: Each branch returns the result type for its operation.
    return (await this.dispatch(operation, target)) as
      | DeviceOperationResult[T["type"]]
      | DeviceFileError;
  }

  private async dispatch(operation: DeviceOperation, target: string) {
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

  /** Resolves symlinks and confirms the real path stays in an allowed folder. */
  private async authorize(requested: string) {
    if (!path.isAbsolute(requested))
      return fileError(
        "outside_allowed_folders",
        `Expected an absolute path, received ${requested}`,
      );
    const resolved = await realpathAllowingMissing(path.resolve(requested));
    if (resolved instanceof Error) return resolved;
    const roots = await Promise.all(
      this.policy.roots.map(
        async (root) => await realpathAllowingMissing(root),
      ),
    );
    const inside = roots.some(
      (root) => !(root instanceof Error) && isInside(root, resolved),
    );
    if (!inside)
      return fileError(
        "outside_allowed_folders",
        `${requested} is outside the folders this computer shares with Halo: ${this.policy.roots.join(", ") || "none"}`,
      );
    const home = await realpathAllowingMissing(this.policy.home);
    if (
      !(home instanceof Error) &&
      protectedHomePaths.some((entry) =>
        isInside(path.join(home, entry), resolved),
      )
    )
      return fileError(
        "protected_path",
        `${requested} holds credentials and is never shared with Halo`,
      );
    return resolved;
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
    operation: Extract<DeviceOperation, { type: "files.read" }>,
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
    operation: Extract<DeviceOperation, { type: "files.write" }>,
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

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** A new file's real location is its nearest existing parent's real path. */
async function realpathAllowingMissing(
  target: string,
): Promise<string | DeviceFileError> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    const real = await fs
      .realpath(current)
      .catch((cause: unknown) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      );
    if (!(real instanceof Error)) return path.join(real, ...missing);
    if (!isMissing(real)) return ioError(target, real);
    const parent = path.dirname(current);
    if (parent === current) return ioError(target, real);
    missing.unshift(path.basename(current));
    current = parent;
  }
}

function isMissing(cause: unknown) {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function ioError(target: string, cause: unknown) {
  if (isMissing(cause))
    return fileError("not_found", `${target} does not exist`, cause);
  if (cause instanceof Error && "code" in cause && cause.code === "ENOTDIR")
    return fileError("not_a_directory", `${target} is not a folder`, cause);
  return fileError(
    "io_error",
    `Could not access ${target}: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  );
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
