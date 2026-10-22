import fs from "node:fs/promises";
import path from "node:path";
import * as errore from "errore";
import type {
  DeviceFileAccess,
  DevicePermissionRequest,
} from "@get-halo/client";

export type DeviceFileErrorCode =
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

export function fileError(
  code: DeviceFileErrorCode,
  detail: string,
  cause?: unknown,
) {
  return new DeviceFileError({ code, detail, cause });
}

/** A folder the person allowed the agent to use, and how. */
export type DeviceGrant = { path: string; access: DeviceFileAccess };

/** What the person allowed on this computer. */
export type DevicePermissions = {
  grants: DeviceGrant[];
  /** Whether the agent may run commands in the person's shell. */
  commandsAllowed: boolean;
};

/** The operation needs access the person has not allowed yet. */
export class DevicePermissionRequiredError extends errore.createTaggedError({
  name: "DevicePermissionRequiredError",
  message: "$detail",
}) {
  readonly code = "permission_required";
  readonly request: DevicePermissionRequest;

  constructor(request: DevicePermissionRequest) {
    super({
      detail:
        request.kind === "commands"
          ? "The person has not allowed Halo to run commands on this computer"
          : `The person has not allowed Halo to ${request.access === "write" ? "change" : "read"} files in ${request.folder}`,
    });
    this.request = request;
  }
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

/**
 * Decides what the workspace agent may do on this computer. Folders and
 * commands the person allowed pass. Anything else returns a permission
 * request, which the workspace shows as a card in the chat; the person's
 * answer arrives through grant.
 */
export class DeviceAccess {
  private permissions: DevicePermissions;
  private readonly home: string;
  private readonly save: (permissions: DevicePermissions) => Promise<void>;

  constructor(ctx: {
    permissions: DevicePermissions;
    home: string;
    /** Persists permissions; the host reports its own save failures. */
    save: (permissions: DevicePermissions) => Promise<void>;
  }) {
    this.permissions = ctx.permissions;
    this.home = ctx.home;
    this.save = ctx.save;
  }

  /** Applies permissions loaded or changed outside this object. */
  setPermissions(permissions: DevicePermissions) {
    this.permissions = permissions;
  }

  /** Records the person's answer to a permission card on this computer. */
  async grant(input: {
    request: DevicePermissionRequest;
    access: DeviceFileAccess;
  }) {
    const { request } = input;
    this.permissions =
      request.kind === "commands"
        ? { ...this.permissions, commandsAllowed: true }
        : {
            ...this.permissions,
            grants: [
              ...this.permissions.grants.filter(
                (grant) => grant.path !== request.folder,
              ),
              { path: request.folder, access: input.access },
            ],
          };
    await this.save(this.permissions);
    return this.permissions;
  }

  /** Allows a command once the person allowed commands on this computer. */
  authorizeCommand(input: {
    command: string;
    cwd: string;
  }): void | DevicePermissionRequiredError {
    if (this.permissions.commandsAllowed) return;
    return new DevicePermissionRequiredError({ kind: "commands", ...input });
  }

  /**
   * Returns the real path when allowed. A new grant covers the path itself
   * when `target` is a folder, otherwise the file's parent folder.
   */
  async authorize(input: {
    path: string;
    access: DeviceFileAccess;
    target: "folder" | "file";
  }): Promise<string | DeviceFileError | DevicePermissionRequiredError> {
    if (!path.isAbsolute(input.path))
      return fileError(
        "outside_allowed_folders",
        `Expected an absolute path, received ${input.path}`,
      );
    const resolved = await realpathAllowingMissing(path.resolve(input.path));
    if (resolved instanceof Error) return resolved;
    const home = await realpathAllowingMissing(this.home);
    if (
      !(home instanceof Error) &&
      protectedHomePaths.some((entry) =>
        isInside(path.join(home, entry), resolved),
      )
    )
      return fileError(
        "protected_path",
        `${input.path} holds credentials and is never shared with Halo`,
      );
    const granted = await this.grantFor(resolved);
    if (granted === "write" || granted === input.access) return resolved;
    // A listing asks about the folder itself; a file asks about its folder.
    return new DevicePermissionRequiredError({
      kind: "folder",
      folder: input.target === "folder" ? resolved : path.dirname(resolved),
      access: input.access,
      path: input.path,
    });
  }

  private async grantFor(resolved: string) {
    let best: DeviceFileAccess | undefined;
    for (const grant of this.permissions.grants) {
      const root = await realpathAllowingMissing(grant.path);
      if (root instanceof Error || !isInside(root, resolved)) continue;
      if (grant.access === "write") return "write";
      best = "read";
    }
    return best;
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

export function ioError(target: string, cause: unknown) {
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
