import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AutoUpdater } from "electron";
import type { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import semver from "semver";
import * as errore from "errore";
import type { LoggerApi } from "@get-halo/logger";
import type { AppUpdateStatus } from "@get-halo/web/HostApi";

const executeFile = promisify(execFile);

class MacUpdateError extends errore.createTaggedError({
  name: "MacUpdateError",
  message: "Could not $operation",
}) {}

const releaseSchema = Type.Object({ name: Type.String(), url: Type.String() });
const stateSchema = Type.Object({
  updateBundleURL: Type.String(),
  targetBundleURL: Type.String(),
});
const bundleSchema = Type.Object({
  CFBundleShortVersionString: Type.String(),
  CFBundleExecutable: Type.String(),
});
type Release = Static<typeof releaseSchema>;
type NativeUpdater = Pick<
  AutoUpdater,
  "setFeedURL" | "checkForUpdates" | "quitAndInstall"
> &
  Pick<EventEmitter, "on" | "removeListener">;

/** Owns macOS update recovery. The native updater is an external host boundary. */
export class MacAppUpdater {
  // A feed check never clears a verified download. Only native staging replaces it.
  private pending: Release | undefined;
  private checking: Promise<void | Error> | undefined;
  private downloading = false;
  private downloadTimedOut = false;
  private installing = false;
  private closed = false;
  private readonly abort = new AbortController();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private installTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelDownload: (() => void) | undefined;
  private readonly native: NativeUpdater;
  private readonly version: string;
  private readonly feedUrl: string;
  private readonly statePath: string;
  private readonly bundlePath: string;
  private readonly logger: LoggerApi;
  private readonly onStatus: (status: AppUpdateStatus) => void;
  private readonly onReady: (version: string) => void;
  private readonly onInstallCancelled: () => void;

  constructor(ctx: {
    native: NativeUpdater;
    version: string;
    feedUrl: string;
    statePath: string;
    bundlePath: string;
    logger: LoggerApi;
    onStatus(status: AppUpdateStatus): void;
    onReady(version: string): void;
    onInstallCancelled(): void;
  }) {
    this.native = ctx.native;
    this.version = ctx.version;
    this.feedUrl = ctx.feedUrl;
    this.statePath = ctx.statePath;
    this.bundlePath = ctx.bundlePath;
    this.logger = ctx.logger;
    this.onStatus = ctx.onStatus;
    this.onReady = ctx.onReady;
    this.onInstallCancelled = ctx.onInstallCancelled;
  }

  start() {
    this.native.on("error", this.nativeError);
    this.pollTimer = setInterval(
      () => void this.check().catch(console.error),
      10 * 60_000,
    );
    this.pollTimer.unref();
    void this.check().catch(console.error);
  }

  close() {
    this.closed = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.installTimer);
    this.abort.abort();
    this.cancelDownload?.();
    this.native.removeListener("error", this.nativeError);
  }

  async check() {
    if (this.closed || this.installing || this.downloadTimedOut) return;
    if (this.checking !== undefined) return await this.checking;
    this.checking = this.checkUnqueued().finally(() => {
      this.checking = undefined;
    });
    return await this.checking;
  }

  private async checkUnqueued() {
    if (this.pending !== undefined) {
      const ready = await this.isStaged(this.pending);
      if (ready instanceof Error) return this.failed(ready);
      if (!ready) this.pending = undefined;
    }
    if (this.closed) return;
    if (this.pending === undefined) this.onStatus({ state: "checking" });
    const response = await fetch(this.feedUrl, {
      cache: "no-store",
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]),
    }).catch(
      (cause) => new MacUpdateError({ operation: "check for updates", cause }),
    );
    if (this.closed) return;
    if (response instanceof Error) return this.failed(response);
    if (response.status === 204) {
      if (this.pending === undefined) this.onStatus({ state: "idle" });
      return;
    }
    if (!response.ok)
      return this.failed(
        new MacUpdateError({
          operation: `check for updates (HTTP ${response.status})`,
        }),
      );
    const json: unknown = await response
      .json()
      .catch(
        (cause) =>
          new MacUpdateError({ operation: "read the update feed", cause }),
      );
    if (this.closed) return;
    if (json instanceof Error) return this.failed(json);
    if (!Value.Check(releaseSchema, json) || semver.valid(json.name) === null)
      return this.failed(
        new MacUpdateError({ operation: "read valid update metadata" }),
      );
    const release = json;
    if (!semver.gt(release.name, this.version)) {
      if (this.pending === undefined) this.onStatus({ state: "idle" });
      return;
    }
    if (
      this.pending !== undefined &&
      !semver.gt(release.name, this.pending.name)
    )
      return;
    this.pending = undefined;
    this.downloading = true;
    this.onStatus({ state: "available" });
    const downloaded = await this.download();
    this.downloading = false;
    if (this.closed) return;
    if (downloaded instanceof Error) return this.failed(downloaded);
    // The feed can advance while the native downloader is fetching it.
    if (
      !semver.gt(downloaded.name, this.version) ||
      semver.lt(downloaded.name, release.name)
    )
      return this.failed(
        new MacUpdateError({ operation: "stage a newer version of Halo" }),
      );
    const ready = await this.isStaged(downloaded);
    if (this.closed) return;
    if (ready instanceof Error) return this.failed(ready);
    if (!ready)
      return this.failed(
        new MacUpdateError({ operation: "find the downloaded update" }),
      );
    this.pending = downloaded;
    this.logger.info({
      event: "update-staged",
      installedVersion: this.version,
      version: downloaded.name,
    });
    this.onStatus({ state: "downloaded", version: downloaded.name });
    this.onReady(downloaded.name);
  }

  private async download(): Promise<Release | Error> {
    return await new Promise<Release | Error>((resolve) => {
      const finish = (result: Release | Error) => {
        clearTimeout(timeout);
        this.native.removeListener("update-downloaded", downloaded);
        this.native.removeListener("update-not-available", unavailable);
        this.native.removeListener("error", failed);
        this.cancelDownload = undefined;
        resolve(result);
      };
      const downloaded = (
        _event: Electron.Event,
        _notes: string,
        name: string,
        _date: Date,
        url: string,
      ) => {
        finish(
          semver.valid(name) === null
            ? new MacUpdateError({ operation: "read the downloaded version" })
            : { name, url },
        );
      };
      const unavailable = () =>
        finish(
          new MacUpdateError({
            operation:
              "download the advertised update; a fresh check will retry",
          }),
        );
      const failed = (cause: Error) =>
        finish(new MacUpdateError({ operation: "download the update", cause }));
      // Squirrel has a 20-minute download timeout. Never start overlapping downloads.
      const timeout = setTimeout(() => {
        const error = new MacUpdateError({
          operation: "finish downloading the update; restart Halo to retry",
        });
        this.downloadTimedOut = true;
        finish(error);
        // Native cancellation is not exposed. Do not race another download in this process.
        // Keep the lifetime error listener until app exit to absorb late native failures.
      }, 21 * 60_000);
      timeout.unref();
      this.cancelDownload = () =>
        finish(
          new MacUpdateError({ operation: "download while Halo is closing" }),
        );
      this.native.on("update-downloaded", downloaded);
      this.native.on("update-not-available", unavailable);
      this.native.on("error", failed);
      const started = errore.try({
        try: () => {
          // Electron recreates SQRLUpdater here, clearing its in-memory ZIP ETag.
          // A deleted/failed download must not receive a 304 for a file it no longer has.
          this.native.setFeedURL({ url: this.feedUrl });
          this.native.checkForUpdates();
        },
        catch: (cause) =>
          new MacUpdateError({ operation: "start the update download", cause }),
      });
      if (started instanceof Error) finish(started);
    });
  }

  async install() {
    // The restart option remains available while a ready update is checked.
    // Finish that check before validating whichever download it leaves ready.
    if (this.pending !== undefined && this.checking !== undefined)
      await this.checking;
    if (this.closed || this.installing || this.checking !== undefined)
      return new MacUpdateError({
        operation: "install while another update operation is in progress",
      });
    this.installing = true;
    const pending = this.pending;
    const ready = pending === undefined ? false : await this.isStaged(pending);
    if (this.closed) return;
    if (pending === undefined || ready instanceof Error || !ready) {
      this.installing = false;
      this.pending = undefined;
      const error =
        ready instanceof Error
          ? ready
          : new MacUpdateError({
              operation: "find the staged update; downloading a fresh copy",
            });
      this.failed(error);
      void this.check().catch(console.error);
      return error;
    }
    this.logger.info({
      event: "update-install-requested",
      installedVersion: this.version,
      version: pending.name,
    });
    // A renderer can veto quitting, or the native installer can fail asynchronously.
    // If this process is still alive, allow recovery instead of staying stuck installing.
    this.installTimer = setTimeout(
      () =>
        this.installFailed(
          new MacUpdateError({
            operation: "finish restarting Halo; retry installation",
          }),
        ),
      30_000,
    );
    this.installTimer.unref();
    const installed = errore.try({
      try: () => this.native.quitAndInstall(),
      catch: (cause) =>
        new MacUpdateError({ operation: "start installation", cause }),
    });
    if (installed instanceof Error) {
      this.installFailed(installed);
      return installed;
    }
  }

  private nativeError = (cause: Error) => {
    if (this.downloading || this.closed) return;
    if (this.downloadTimedOut) {
      this.logger.warn({ event: "update-download-timed-out", error: cause });
      return;
    }
    const error = new MacUpdateError({
      operation: "install the downloaded update",
      cause,
    });
    if (this.installing) this.installFailed(error);
    else this.failed(error);
  };

  private installFailed(error: Error) {
    clearTimeout(this.installTimer);
    this.installing = false;
    this.pending = undefined;
    this.onInstallCancelled();
    this.failed(error);
    void this.check().catch(console.error);
  }

  private failed(error: Error) {
    this.logger.warn({ event: "update-failed", error });
    if (this.pending === undefined)
      this.onStatus({ state: "error", message: error.message });
    return error;
  }

  private async isStaged(release: Release) {
    const state = await readPlist({
      file: this.statePath,
      schema: stateSchema,
    });
    if (state instanceof Error) {
      this.logger.warn({ event: "update-state-unreadable", error: state });
      return false;
    }
    if (state === undefined) return false;
    const locations = errore.try({
      try: () => ({
        staged: fileURLToPath(state.updateBundleURL),
        target: fileURLToPath(state.targetBundleURL),
      }),
      catch: (cause) =>
        new MacUpdateError({
          operation: "read the staged update location",
          cause,
        }),
    });
    if (locations instanceof Error) {
      this.logger.warn({ event: "update-state-unreadable", error: locations });
      return false;
    }
    if (path.resolve(locations.target) !== path.resolve(this.bundlePath))
      return false;
    const info = await readPlist({
      file: path.join(locations.staged, "Contents/Info.plist"),
      schema: bundleSchema,
    });
    if (info instanceof Error) {
      this.logger.warn({ event: "update-bundle-unreadable", error: info });
      return false;
    }
    if (info === undefined) return false;
    if (info.CFBundleShortVersionString !== release.name) return false;
    const executable = info.CFBundleExecutable;
    const present = await fs
      .stat(path.join(locations.staged, "Contents/MacOS", executable))
      .catch((cause: NodeJS.ErrnoException) =>
        cause.code === "ENOENT"
          ? undefined
          : new MacUpdateError({
              operation: "read the staged application",
              cause,
            }),
      );
    if (present instanceof Error) return present;
    return present?.isFile() === true;
  }
}

async function readPlist<T extends TSchema>({
  file,
  schema,
}: {
  file: string;
  schema: T;
}) {
  const exists = await fs
    .stat(file)
    .catch((cause: NodeJS.ErrnoException) =>
      cause.code === "ENOENT"
        ? undefined
        : new MacUpdateError({ operation: "read the update state", cause }),
    );
  if (exists instanceof Error || exists === undefined) return exists;
  const result = await executeFile("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    file,
  ]).catch(
    (cause) =>
      new MacUpdateError({ operation: "decode the update state", cause }),
  );
  if (result instanceof Error) return result;
  const parsed: unknown = errore.try({
    try: () => JSON.parse(result.stdout),
    catch: (cause) =>
      new MacUpdateError({ operation: "parse the update state", cause }),
  });
  if (parsed instanceof Error) return parsed;
  if (!Value.Check(schema, parsed))
    return new MacUpdateError({ operation: "read valid update state" });
  return parsed;
}
