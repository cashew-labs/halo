import fs from "node:fs/promises";
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

  /** Remove only the matching remote app, keeping its marker until cleanup ends. */
  async delete(ctx: { extensionId: string; appId: string }) {
    if (!Value.Check(appIdSchema, ctx.appId))
      return new AppPublicationError({ detail: "invalid app ID" });
    const current = await this.read(ctx.extensionId);
    if (current instanceof Error) return current;
    if (current !== undefined) {
      if (current.appId !== ctx.appId || current.state !== "remote")
        return new AppPublicationError({
          detail: "only the matching remote app can be deleted",
        });
      // A cutover can have left source or data behind; retire it before deletion.
      const retired = await this.retireLocalCopies(ctx);
      if (retired instanceof Error) return retired;
    }
    const removed = await fs
      .rm(path.join(this.workspaceRoot, ".halo/published-backups", ctx.appId), {
        recursive: true,
        force: true,
      })
      .catch(
        (cause) => new AppPublicationError({ detail: "delete backup", cause }),
      );
    if (removed instanceof Error) return removed;
    const file = this.markerPath(ctx.extensionId);
    if (file instanceof Error) return file;
    return await fs
      .rm(file, { force: true })
      .catch(
        (cause) =>
          new AppPublicationError({ detail: "delete reference", cause }),
      );
  }

  async retireLocalCopies(ctx: { extensionId: string; appId: string }) {
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
