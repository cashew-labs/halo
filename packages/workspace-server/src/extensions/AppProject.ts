import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as errore from "errore";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import type { ExtensionArtifact } from "@get-halo/client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export class AppProjectError extends errore.createTaggedError({
  name: "AppProjectError",
  message: "App project failed: $detail",
}) {}

// Text source travels as UTF-8; every other regular file travels as base64.
const sourceTypes = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".json",
  ".css",
  ".svg",
  ".md",
  ".txt",
  ".html",
  ".sh",
  ".bash",
  ".py",
]);
const maxBytes = 16 * 1024 * 1024;
const maxEntries = 256;
const fileNameSchema = Type.String({ minLength: 1, maxLength: 1024 });
const textSchema = Type.String({ maxLength: maxBytes });
const buildIdSchema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const artifactSchema = Type.Object(
  {
    files: Type.Record(Type.String(), Type.String()),
    assets: Type.Record(Type.String(), Type.String()),
    build: Type.Record(Type.String(), Type.String()),
    data: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Source is writable only through owner operations, outside the public runtime. */
export class AppProject {
  private readonly actionQueue = new SerialQueue();
  private readonly directory: string;
  private readonly dataDirectory: string;

  constructor(ctx: { workspaceRoot: string; extensionId: string }) {
    this.directory = path.join(
      ctx.workspaceRoot,
      ".halo/extensions",
      ctx.extensionId,
    );
    this.dataDirectory = path.join(
      ctx.workspaceRoot,
      ".halo/extension-data",
      ctx.extensionId,
    );
  }

  async snapshot(dataOverride?: { contents: string | undefined }) {
    return await this.actionQueue.run(async () => {
      const files: [string, string][] = [];
      const assets: [string, string][] = [];
      const captured = await this.capture({
        directory: this.directory,
        files,
        assets,
      });
      if (captured instanceof Error) return captured;
      const current = await fs
        .readFile(path.join(this.directory, "dist/current.json"), "utf8")
        .catch(
          (cause) =>
            new AppProjectError({ detail: "read current build", cause }),
        );
      if (current instanceof Error) return current;
      const buildId = errore.try({
        // SAFETY: buildIdSchema validates the decoded JSON below.
        try: () => JSON.parse(current) as unknown,
        catch: (cause) =>
          new AppProjectError({ detail: "decode current build", cause }),
      });
      if (buildId instanceof Error) return buildId;
      if (!Value.Check(buildIdSchema, buildId))
        return new AppProjectError({ detail: "invalid current build" });
      const build: [string, string][] = [];
      const compiled = await this.capture({
        directory: path.join(this.directory, "dist", buildId),
        files: [],
        assets: build,
        compiled: true,
      });
      if (compiled instanceof Error) return compiled;
      for (const file of ["dist/start.mjs", "dist/current.json"]) {
        const contents = await this.readFile(file, { compiled: true });
        if (contents instanceof Error) return contents;
        build.push([file, contents.toString("base64")]);
      }
      const dataPath = path.join(this.dataDirectory, "tandem.json");
      const data =
        dataOverride !== undefined
          ? dataOverride.contents
          : await fs
              .readFile(dataPath, "utf8")
              .catch((cause: NodeJS.ErrnoException) =>
                cause.code === "ENOENT"
                  ? undefined
                  : new AppProjectError({ detail: "read app data", cause }),
              );
      if (data instanceof Error) return data;
      // install() refuses artifacts over the same total, so one limit covers
      // source, assets and build together.
      if (files.length + assets.length + build.length > maxEntries)
        return new AppProjectError({
          detail: `project exceeds ${maxEntries}-file transfer limit`,
        });
      const artifact = {
        files: Object.fromEntries(files),
        assets: Object.fromEntries(assets),
        build: Object.fromEntries(build),
        data,
      };
      if (Buffer.byteLength(JSON.stringify(artifact)) > maxBytes)
        return new AppProjectError({
          detail: "project exceeds 16 MiB transfer limit",
        });
      return artifact;
    });
  }

  async install(artifact: ExtensionArtifact) {
    return await this.actionQueue.run(async () => {
      if (!Value.Check(artifactSchema, artifact))
        return new AppProjectError({ detail: "invalid project artifact" });
      if (Buffer.byteLength(JSON.stringify(artifact)) > maxBytes)
        return new AppProjectError({
          detail: "project exceeds 16 MiB transfer limit",
        });
      const entries = [
        ...Object.entries(artifact.files).map(
          ([name, source]) =>
            [name, Buffer.from(source), { text: true }] as const,
        ),
        ...Object.entries(artifact.assets).map(
          ([name, encoded]) =>
            [name, Buffer.from(encoded, "base64"), {}] as const,
        ),
        ...Object.entries(artifact.build).map(
          ([name, encoded]) =>
            [name, Buffer.from(encoded, "base64"), { compiled: true }] as const,
        ),
      ];
      if (
        entries.length > maxEntries ||
        !artifact.files["package.json"] ||
        !artifact.build["dist/start.mjs"]
      )
        return new AppProjectError({ detail: "invalid project artifact" });
      for (const [name, , kind] of entries) {
        const valid = this.fileName(name, kind);
        if (valid instanceof Error) return valid;
      }
      const parent = await fs
        .mkdir(path.dirname(this.directory), { recursive: true, mode: 0o700 })
        .catch(
          (cause) =>
            new AppProjectError({ detail: "create projects directory", cause }),
        );
      if (parent instanceof Error) return parent;
      const created = await fs.mkdir(this.directory, { mode: 0o700 }).catch(
        (cause) =>
          new AppProjectError({
            detail: "project already exists or cannot be created",
            cause,
          }),
      );
      if (created instanceof Error) return created;
      let installed = false;
      let createdData = false;
      await using cleanup = new errore.AsyncDisposableStack();
      cleanup.defer(async () => {
        if (installed) return;
        const removed = await Promise.all([
          fs.rm(this.directory, { recursive: true, force: true }),
          createdData
            ? fs.rm(path.join(this.dataDirectory, "tandem.json"), {
                force: true,
              })
            : undefined,
        ]).catch(
          (cause) =>
            new AppProjectError({ detail: "remove failed install", cause }), // coverage-exempt: Last-resort cleanup failure; successful rollback is exercised with partial imports.
        );
        if (removed instanceof Error) console.warn(removed);
      });
      for (const [name, contents, kind] of entries) {
        const written = await this.writeFile({ name, contents, ...kind });
        if (written instanceof Error) return written;
      }
      if (artifact.data !== undefined) {
        const dataDirectory = await fs
          .mkdir(this.dataDirectory, { recursive: true, mode: 0o700 })
          .catch(
            (cause) =>
              new AppProjectError({
                detail: "create app data directory",
                cause,
              }),
          );
        if (dataDirectory instanceof Error) return dataDirectory;
        // Exclusive open keeps existing data; only a file this install created
        // is removed on rollback.
        const file = await fs
          .open(path.join(this.dataDirectory, "tandem.json"), "wx", 0o600)
          .catch(
            (cause) =>
              new AppProjectError({ detail: "import app data", cause }),
          );
        if (file instanceof Error) return file;
        createdData = true;
        const written = await file
          .writeFile(artifact.data)
          .finally(async () => await file.close())
          .catch(
            (cause) =>
              new AppProjectError({ detail: "import app data", cause }),
          );
        if (written instanceof Error) return written;
      }
      installed = true;
    });
  }

  async read(name: string) {
    return await this.actionQueue.run(async () => {
      const contents = await this.readFile(name);
      if (contents instanceof Error) return contents;
      if (!sourceTypes.has(path.extname(name)))
        return new AppProjectError({ detail: `${name} is not text source` });
      return contents.toString("utf8");
    });
  }

  async write(ctx: { name: string; contents: string }) {
    return await this.actionQueue.run(async () => {
      if (!Value.Check(textSchema, ctx.contents))
        return new AppProjectError({ detail: "invalid source text" });
      if (Buffer.byteLength(ctx.contents) > maxBytes)
        return new AppProjectError({ detail: "file exceeds transfer limit" });
      return await this.writeFile({
        name: ctx.name,
        contents: Buffer.from(ctx.contents),
        text: true,
      });
    });
  }

  /**
   * Source paths exclude dotfiles and dependencies. Compiled paths stay under
   * `dist/` and keep every name, because a build may emit any file type.
   */
  private fileName(
    name: string,
    kind: { text?: boolean; compiled?: boolean } = {},
  ) {
    const parts = name.split("/");
    if (
      !Value.Check(fileNameSchema, name) ||
      name.includes("\\") ||
      path.posix.isAbsolute(name) ||
      path.posix.normalize(name) !== name ||
      parts.some((part) => part === "." || part === "..") ||
      (kind.compiled
        ? parts[0] !== "dist" || parts.length < 2
        : parts[0] === "dist" ||
          parts.some(
            (part) => part.startsWith(".") || part === "node_modules",
          )) ||
      (kind.text === true && !sourceTypes.has(path.extname(name)))
    )
      return new AppProjectError({ detail: `invalid project path ${name}` });
    return path.join(this.directory, name);
  }

  private async readFile(name: string, kind: { compiled?: boolean } = {}) {
    const target = await this.target(name, kind);
    if (target instanceof Error) return target;
    const info = await fs
      .stat(target)
      .catch(
        (cause) =>
          new AppProjectError({ detail: "inspect source file", cause }),
      );
    if (info instanceof Error) return info;
    if (!info.isFile() || info.size > maxBytes)
      return new AppProjectError({
        detail: "invalid source file or transfer limit exceeded",
      });
    return await fs
      .readFile(target)
      .catch((cause) => new AppProjectError({ detail: "read source", cause }));
  }

  private async writeFile(ctx: {
    name: string;
    contents: Buffer;
    text?: boolean;
    compiled?: boolean;
  }) {
    const target = await this.target(ctx.name, ctx);
    if (target instanceof Error) return target;
    const created = await fs
      .mkdir(path.dirname(target), { recursive: true })
      .catch(
        (cause) =>
          new AppProjectError({ detail: "create source directory", cause }),
      );
    if (created instanceof Error) return created;
    const temporary = path.join(path.dirname(target), `.${randomUUID()}.tmp`);
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const removed = await fs.rm(temporary, { force: true }).catch(
        (cause) =>
          new AppProjectError({ detail: "remove temporary source", cause }), // coverage-exempt: Last-resort cleanup failure; atomic replacement and rollback are exercised with filesystem failures.
      );
      if (removed instanceof Error) console.warn(removed);
    });
    const written = await fs
      .writeFile(temporary, ctx.contents, { flag: "wx", mode: 0o600 })
      .catch((cause) => new AppProjectError({ detail: "write source", cause }));
    if (written instanceof Error) return written;
    return await fs
      .rename(temporary, target)
      .catch(
        (cause) => new AppProjectError({ detail: "commit source edit", cause }),
      );
  }

  private async target(
    name: string,
    kind: { text?: boolean; compiled?: boolean } = {},
  ) {
    const target = this.fileName(name, kind);
    if (target instanceof Error) return target;
    for (const component of [
      this.directory,
      ...name
        .split("/")
        .map((_part, index, parts) =>
          path.join(this.directory, ...parts.slice(0, index + 1)),
        ),
    ]) {
      const info = await fs
        .lstat(component)
        .catch((cause: NodeJS.ErrnoException) =>
          cause.code === "ENOENT"
            ? undefined
            : new AppProjectError({ detail: "inspect source path", cause }),
        );
      if (info instanceof Error) return info;
      if (info?.isSymbolicLink())
        return new AppProjectError({
          detail: "source symlinks are unsupported",
        });
    }
    return target;
  }

  private async capture(ctx: {
    directory: string;
    files: [string, string][];
    assets: [string, string][];
    compiled?: boolean;
  }): Promise<void | AppProjectError> {
    const entries = await fs
      .readdir(ctx.directory, { withFileTypes: true })
      .catch((cause) => new AppProjectError({ detail: "list source", cause }));
    if (entries instanceof Error) return entries;
    for (const entry of entries) {
      const file = path.join(ctx.directory, entry.name);
      const name = path
        .relative(this.directory, file)
        .split(path.sep)
        .join("/");
      // Source capture skips local-only state; compiled output keeps every file.
      if (
        !ctx.compiled &&
        (entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          name === "dist")
      )
        continue;
      if (entry.isSymbolicLink())
        return new AppProjectError({
          detail: `source symlinks are unsupported: ${name}`,
        });
      if (entry.isDirectory()) {
        const captured = await this.capture({ ...ctx, directory: file });
        if (captured instanceof Error) return captured;
        continue;
      }
      if (!entry.isFile())
        return new AppProjectError({
          detail: `unsupported source entry: ${name}`,
        });
      const contents = await this.readFile(name, ctx);
      if (contents instanceof Error) return contents;
      const size = [...ctx.files, ...ctx.assets].reduce(
        (sum, [, item]) => sum + Buffer.byteLength(item),
        0,
      );
      if (
        contents.length > maxBytes ||
        size + contents.length > maxBytes ||
        ctx.files.length + ctx.assets.length >= maxEntries
      )
        return new AppProjectError({
          detail: "project exceeds transfer limit",
        });
      if (ctx.compiled || !sourceTypes.has(path.extname(name)))
        ctx.assets.push([name, contents.toString("base64")]);
      else ctx.files.push([name, contents.toString("utf8")]);
    }
  }
}
