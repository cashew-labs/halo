import fs from "node:fs/promises";
import { AppProject } from "./AppProject.js";
import type { ExtensionArtifact } from "@get-halo/client";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as errore from "errore";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export class AppPublicationError extends errore.createTaggedError({
  name: "AppPublicationError",
  message: "App publication failed: $detail",
}) {}

const appIdSchema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const extensionIdSchema = Type.String({ pattern: "^[a-z][a-z0-9-]{0,79}$" });
const markerSchema = Type.Union([
  Type.Object(
    { state: Type.Literal("publishing"), appId: appIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal("remote"),
      appId: appIdSchema,
      url: Type.String({ pattern: "^https?://", maxLength: 2048 }),
      displayName: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
  ),
]);
type AppPublicationState = Static<typeof markerSchema>;

/**
 * Owner-side publication state. A frozen project stays stopped and unchanged
 * while the control plane copies it; a remote reference replaces it once the
 * app VM is authoritative, so the workspace never runs a second copy.
 */
export class AppPublication {
  private readonly workspaceRoot: string;

  constructor(ctx: { workspaceRoot: string }) {
    this.workspaceRoot = ctx.workspaceRoot;
  }

  async read(extensionId: string) {
    const file = this.markerPath(extensionId);
    if (file instanceof Error) return file;
    const contents = await fs
      .readFile(file, "utf8")
      .catch((cause: NodeJS.ErrnoException) =>
        cause.code === "ENOENT"
          ? undefined
          : new AppPublicationError({ detail: "read state", cause }),
      );
    if (contents === undefined || contents instanceof Error) return contents;
    const marker = errore.try({
      // SAFETY: markerSchema validates the decoded JSON below.
      try: () => JSON.parse(contents) as unknown,
      catch: (cause) => new AppPublicationError({ detail: "decode", cause }),
    });
    if (marker instanceof Error) return marker;
    if (!Value.Check(markerSchema, marker))
      return new AppPublicationError({ detail: "invalid state" });
    return marker;
  }

  async list() {
    const directory = path.join(this.workspaceRoot, ".halo/app-publication");
    const entries = await fs
      .readdir(directory)
      .catch((cause: NodeJS.ErrnoException) =>
        cause.code === "ENOENT"
          ? []
          : new AppPublicationError({ detail: "list states", cause }),
      );
    if (entries instanceof Error) return entries;
    const states: (AppPublicationState & { extensionId: string })[] = [];
    for (const entry of entries.toSorted((a, b) => a.localeCompare(b))) {
      if (!entry.endsWith(".json")) continue;
      const extensionId = entry.slice(0, -".json".length);
      if (!Value.Check(extensionIdSchema, extensionId)) continue;
      const state = await this.read(extensionId);
      if (state instanceof Error) return state;
      if (state !== undefined) states.push({ ...state, extensionId });
    }
    return states;
  }

  async freeze(ctx: { extensionId: string; appId: string }) {
    const current = await this.read(ctx.extensionId);
    if (current instanceof Error) return current;
    if (current !== undefined)
      return current.appId === ctx.appId
        ? undefined
        : new AppPublicationError({ detail: "already published elsewhere" });
    const source = await fs
      .stat(this.sourcePath(ctx.extensionId))
      .catch(
        (cause) => new AppPublicationError({ detail: "find project", cause }),
      );
    if (source instanceof Error) return source;
    return await this.write(ctx.extensionId, {
      state: "publishing",
      appId: ctx.appId,
    });
  }

  async release(ctx: { extensionId: string; appId: string }) {
    const current = await this.read(ctx.extensionId);
    if (current === undefined || current instanceof Error) return current;
    if (current.appId !== ctx.appId || current.state !== "publishing")
      return new AppPublicationError({
        detail: "publication cannot be undone",
      });
    const file = this.markerPath(ctx.extensionId);
    if (file instanceof Error) return file;
    return await fs
      .rm(file)
      .catch((cause) => new AppPublicationError({ detail: "release", cause })); // coverage-exempt: Filesystem failure removing a marker this process just read.
  }

  /** References an app that never existed locally; idempotent per app. */
  async addRemote(ctx: {
    extensionId: string;
    appId: string;
    url: string;
    displayName: string;
  }) {
    const current = await this.read(ctx.extensionId);
    if (current instanceof Error) return current;
    if (current !== undefined)
      return current.appId === ctx.appId && current.state === "remote"
        ? undefined
        : new AppPublicationError({ detail: "extension ID is in use" });
    const local = await fs
      .stat(this.sourcePath(ctx.extensionId))
      .then(() => true)
      .catch((cause: NodeJS.ErrnoException) =>
        cause.code === "ENOENT"
          ? false
          : new AppPublicationError({ detail: "find project", cause }),
      );
    if (local instanceof Error) return local;
    if (local)
      return new AppPublicationError({ detail: "extension ID is in use" });
    return await this.write(ctx.extensionId, {
      state: "remote",
      appId: ctx.appId,
      url: ctx.url,
      displayName: ctx.displayName,
    });
  }

  /** Persist the reference first, then retire local copies; both steps retry. */
  async complete(ctx: {
    extensionId: string;
    appId: string;
    url: string;
    displayName: string;
  }) {
    const current = await this.read(ctx.extensionId);
    if (current instanceof Error) return current;
    if (current === undefined || current.appId !== ctx.appId)
      return new AppPublicationError({ detail: "project is not frozen" });
    if (current.state === "publishing") {
      const written = await this.write(ctx.extensionId, {
        state: "remote",
        appId: ctx.appId,
        url: ctx.url,
        displayName: ctx.displayName,
      });
      if (written instanceof Error) return written;
    }
    return await this.retireLocalCopies({
      extensionId: ctx.extensionId,
      appId: ctx.appId,
    });
  }

  /** Save the latest hosted project before its VM can be removed. */
  async prepareRemoval(ctx: {
    extensionId: string;
    appId: string;
    artifact?: ExtensionArtifact;
  }) {
    const valid = this.removalRoot(ctx);
    if (valid instanceof Error) return valid;
    const current = await this.read(ctx.extensionId);
    if (current instanceof Error) return current;
    const prepared = await fs
      .readFile(path.join(valid, "ready"), "utf8")
      .catch((cause: NodeJS.ErrnoException) =>
        cause.code === "ENOENT"
          ? undefined
          : new AppPublicationError({ detail: "read saved extension", cause }),
      );
    if (prepared instanceof Error) return prepared;
    if (prepared === ctx.extensionId) return true;
    if (current?.state !== "remote" || current.appId !== ctx.appId)
      return new AppPublicationError({
        detail: "only the matching remote app can be removed",
      });
    if (ctx.artifact === undefined) return false;
    const installed = await new AppProject({
      workspaceRoot: valid,
      extensionId: ctx.extensionId,
    }).install(ctx.artifact, ctx.appId);
    if (installed instanceof Error) return installed;
    const saved = await fs
      .writeFile(path.join(valid, "ready"), ctx.extensionId, { mode: 0o600 })
      .catch(
        (cause) =>
          new AppPublicationError({ detail: "save removal progress", cause }),
      );
    if (saved instanceof Error) return saved;
    return true;
  }

  /** Switch back to the saved local extension only after the VM is gone. */
  async completeRemoval(ctx: { extensionId: string; appId: string }) {
    const root = this.removalRoot(ctx);
    if (root instanceof Error) return root;
    const current = await this.read(ctx.extensionId);
    if (current instanceof Error) return current;
    if (current === undefined) return;
    if (current.state !== "remote" || current.appId !== ctx.appId)
      return new AppPublicationError({
        detail: "only the matching remote app can be removed",
      });
    const prepared = await this.prepareRemoval(ctx);
    if (prepared instanceof Error) return prepared;
    if (!prepared)
      return new AppPublicationError({
        detail: "save the hosted extension before removing its VM",
      });
    for (const directory of ["extensions", "extension-data"]) {
      const target = path.join(
        this.workspaceRoot,
        ".halo",
        directory,
        ctx.extensionId,
      );
      const created = await fs
        .mkdir(path.dirname(target), { recursive: true })
        .catch(
          (cause) =>
            new AppPublicationError({
              detail: "create local extension directory",
              cause,
            }),
        );
      if (created instanceof Error) return created;
      const moved = await fs
        .rename(path.join(root, ".halo", directory, ctx.extensionId), target)
        .catch((cause: NodeJS.ErrnoException) =>
          cause.code === "ENOENT"
            ? undefined
            : new AppPublicationError({
                detail: "restore local extension",
                cause,
              }),
        );
      if (moved instanceof Error) return moved;
    }
    const localAppId = await this.localAppId(ctx.extensionId);
    if (localAppId instanceof Error) return localAppId;
    if (localAppId !== ctx.appId)
      return new AppPublicationError({ detail: "saved extension is missing" });
    const file = this.markerPath(ctx.extensionId);
    if (file instanceof Error) return file;
    return await fs
      .rm(file, { force: true })
      .catch(
        (cause) =>
          new AppPublicationError({ detail: "remove app reference", cause }),
      );
  }

  async localAppId(extensionId: string) {
    const valid = this.markerPath(extensionId);
    if (valid instanceof Error) return valid;
    return await this.readAppId(this.sourcePath(extensionId));
  }

  private async readAppId(directory: string) {
    const appId = await fs
      .readFile(path.join(directory, ".install-id"), "utf8")
      .catch((cause: NodeJS.ErrnoException) =>
        cause.code === "ENOENT"
          ? undefined
          : new AppPublicationError({
              detail: "read local app identity",
              cause,
            }),
      );
    if (appId === undefined || appId instanceof Error) return appId;
    if (!Value.Check(appIdSchema, appId))
      return new AppPublicationError({ detail: "invalid local app identity" });
    return appId;
  }

  private async backupAppIds(appId: string) {
    const appIds = [appId];
    // A republished local extension carries the prior install ID in its backup.
    for (const currentAppId of appIds) {
      const previous = await this.readAppId(
        path.join(
          this.workspaceRoot,
          ".halo/published-backups",
          currentAppId,
          "source",
        ),
      );
      if (previous instanceof Error) return previous;
      if (previous === undefined) continue;
      if (appIds.includes(previous))
        return new AppPublicationError({
          detail: "publication backup identities form a cycle",
        });
      appIds.push(previous);
    }
    return appIds;
  }

  async deleteExtension(ctx: {
    extensionId: string;
    appId: string | undefined;
  }) {
    const appIds =
      ctx.appId === undefined ? [] : await this.backupAppIds(ctx.appId);
    if (appIds instanceof Error) return appIds;
    const directories = [
      ...appIds
        .toReversed()
        .flatMap((appId) => [
          path.join(this.workspaceRoot, ".halo/published-backups", appId),
          path.join(this.workspaceRoot, ".halo/app-removals", appId),
        ]),
      path.join(this.workspaceRoot, ".halo/extension-data", ctx.extensionId),
      this.sourcePath(ctx.extensionId),
    ];
    // Source is last so a failed cleanup retains the app ID for a retry.
    for (const directory of directories) {
      const removed = await fs
        .rm(directory, { recursive: true, force: true })
        .catch(
          (cause) =>
            new AppPublicationError({
              detail: "delete local extension files",
              cause,
            }),
        );
      if (removed instanceof Error) return removed;
    }
  }

  private removalRoot(ctx: { extensionId: string; appId: string }) {
    const valid = this.markerPath(ctx.extensionId);
    if (valid instanceof Error) return valid;
    if (!Value.Check(appIdSchema, ctx.appId))
      return new AppPublicationError({ detail: "invalid app ID" });
    return path.join(this.workspaceRoot, ".halo/app-removals", ctx.appId);
  }

  async retireLocalCopies(ctx: { extensionId: string; appId: string }) {
    // A removal can have restored files before its remote marker was removed.
    const removing = await this.prepareRemoval(ctx);
    if (removing instanceof Error) return removing;
    if (removing) return;
    const backup = path.join(
      this.workspaceRoot,
      ".halo/published-backups",
      ctx.appId,
    );
    const created = await fs
      .mkdir(backup, { recursive: true, mode: 0o700 })
      .catch(
        (cause) => new AppPublicationError({ detail: "create backup", cause }),
      );
    if (created instanceof Error) return created;
    for (const [from, to] of [
      [this.sourcePath(ctx.extensionId), path.join(backup, "source")],
      [
        path.join(this.workspaceRoot, ".halo/extension-data", ctx.extensionId),
        path.join(backup, "data"),
      ],
    ] as const) {
      const moved = await fs
        .rename(from, to)
        .catch((cause: NodeJS.ErrnoException) =>
          cause.code === "ENOENT"
            ? undefined
            : new AppPublicationError({ detail: "retire local copy", cause }),
        );
      if (moved instanceof Error) return moved;
    }
  }

  private sourcePath(extensionId: string) {
    return path.join(this.workspaceRoot, ".halo/extensions", extensionId);
  }

  private markerPath(extensionId: string) {
    if (!Value.Check(extensionIdSchema, extensionId))
      return new AppPublicationError({ detail: "invalid extension ID" });
    return path.join(
      this.workspaceRoot,
      ".halo/app-publication",
      `${extensionId}.json`,
    );
  }

  private async write(extensionId: string, state: AppPublicationState) {
    const file = this.markerPath(extensionId);
    if (file instanceof Error) return file;
    const created = await fs
      .mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      .catch(
        (cause) => new AppPublicationError({ detail: "create state", cause }),
      );
    if (created instanceof Error) return created;
    const temporary = `${file}.${randomUUID()}.tmp`;
    const written = await fs
      .writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
      .catch(
        (cause) => new AppPublicationError({ detail: "write state", cause }), // coverage-exempt: Filesystem failure after creating the state directory; directory failures are tested.
      );
    if (written instanceof Error) return written;
    return await fs.rename(temporary, file).catch(
      (cause) => new AppPublicationError({ detail: "commit state", cause }), // coverage-exempt: Rename failure within one directory after a successful write.
    );
  }
}
