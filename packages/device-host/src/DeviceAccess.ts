import fs from "node:fs/promises";
import path from "node:path";
import * as errore from "errore";
import type { DeviceFileAccess } from "@get-halo/client";

export type DeviceFileErrorCode =
  | "access_denied"
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

/** The person's answer to an access prompt. */
export type DeviceAccessAnswer = DeviceFileAccess | "deny";

export type DeviceAccessRequest = {
  /** The folder the grant would cover. */
  folder: string;
  /** The access this operation needs. */
  access: DeviceFileAccess;
  /** The path the agent asked for. */
  path: string;
  signal: AbortSignal;
};

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

// Long enough to notice the prompt; shorter than the workspace's call timeout.
const promptTimeoutMs = 4 * 60_000;

/**
 * Decides which paths the workspace agent may use on this computer. Folders
 * the person already allowed pass; anything else asks the person once per
 * folder. Refusals last until the app restarts.
 */
export class DeviceAccess {
  private grants: readonly DeviceGrant[];
  private readonly home: string;
  private readonly ask: (
    request: DeviceAccessRequest,
  ) => Promise<DeviceAccessAnswer>;
  private readonly save: (grants: DeviceGrant[]) => Promise<void>;
  private readonly refused = new Map<string, DeviceFileAccess>();
  private readonly prompts = new Map<string, Promise<DeviceAccessAnswer>>();

  constructor(ctx: {
    grants: readonly DeviceGrant[];
    home: string;
    ask: (request: DeviceAccessRequest) => Promise<DeviceAccessAnswer>;
    /** Persists grants; the host reports its own save failures. */
    save: (grants: DeviceGrant[]) => Promise<void>;
  }) {
    this.grants = ctx.grants;
    this.home = ctx.home;
    this.ask = ctx.ask;
    this.save = ctx.save;
  }

  /** Applies grants the person changed in settings. */
  setGrants(grants: readonly DeviceGrant[]) {
    this.grants = grants;
    this.refused.clear();
  }

  /**
   * Returns the real path when allowed. A new grant covers the path itself
   * when `target` is a folder, otherwise the file's parent folder.
   */
  async authorize(input: {
    path: string;
    access: DeviceFileAccess;
    target: "folder" | "file";
  }): Promise<string | DeviceFileError> {
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
    const folder =
      input.target === "folder" ? resolved : path.dirname(resolved);
    const answer = await this.prompt({
      folder,
      access: input.access,
      path: input.path,
    });
    if (answer === "deny")
      return fileError(
        "access_denied",
        `The person did not allow Halo to ${input.access === "write" ? "change" : "read"} files in ${folder}`,
      );
    if (input.access === "write" && answer === "read")
      return fileError(
        "read_only",
        `The person allowed Halo to read files in ${folder} but not change them`,
      );
    return resolved;
  }

  private async grantFor(resolved: string) {
    let best: DeviceFileAccess | undefined;
    for (const grant of this.grants) {
      const root = await realpathAllowingMissing(grant.path);
      if (root instanceof Error || !isInside(root, resolved)) continue;
      if (grant.access === "write") return "write";
      best = "read";
    }
    return best;
  }

  /** One prompt per folder and access at a time; concurrent calls share it. */
  private async prompt(request: Omit<DeviceAccessRequest, "signal">) {
    if (isAtLeast(this.refused.get(request.folder), request.access))
      return "deny";
    const key = `${request.access}:${request.folder}`;
    const pending = this.prompts.get(key);
    if (pending !== undefined) return await pending;
    const answering = this.answer(request);
    this.prompts.set(key, answering);
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => this.prompts.delete(key));
    return await answering;
  }

  private async answer(request: Omit<DeviceAccessRequest, "signal">) {
    const answer = await this.ask({
      ...request,
      signal: AbortSignal.timeout(promptTimeoutMs),
    }).catch((): DeviceAccessAnswer => "deny");
    if (answer === "deny") {
      this.refused.set(request.folder, request.access);
      return answer;
    }
    const grants = [
      ...this.grants.filter((grant) => grant.path !== request.folder),
      { path: request.folder, access: answer },
    ];
    this.grants = grants;
    await this.save(grants);
    return answer;
  }
}

/** A refusal of write access still lets the person allow reading later. */
function isAtLeast(
  refused: DeviceFileAccess | undefined,
  wanted: DeviceFileAccess,
) {
  return refused === "read" || (refused === "write" && wanted === "write");
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
