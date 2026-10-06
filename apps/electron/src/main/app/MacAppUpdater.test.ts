import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { EventEmitter } from "node:events";
import { Logger } from "@get-halo/logger";
import type { AppUpdateStatus } from "@get-halo/web/HostApi";
import { MacAppUpdater } from "./MacAppUpdater.js";

// Narrow internal contract: native updater recovery, independent of windows/auth/workspaces.
// Extract this service if another desktop host needs its download/install lifecycle.
// The native driver is external; feed requests and Squirrel state files use real I/O.
describe.runIf(process.platform === "darwin")("macOS update recovery", () => {
  let fixture: UpdateFixture;
  beforeEach(async () => {
    fixture = await UpdateFixture.start();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await fixture.close();
  });

  test("downloads, installs, and recognizes the running version on the next launch", async () => {
    await fixture.updater.check();
    expect(fixture.status).toEqual({ state: "downloaded", version: "0.1.54" });
    expect(await fixture.updater.install()).toBeUndefined();
    expect(fixture.native.liveVersion).toBe("0.1.54");
    fixture.relaunch("0.1.54");
    await fixture.updater.check();
    expect(fixture.status).toEqual({ state: "idle" });
  });

  test.each([
    { status: 200, latest: "0.1.54", installed: "0.1.54" },
    { status: 200, latest: "0.1.55", installed: "0.1.55" },
    { status: 500, latest: "0.1.54", installed: "0.1.54" },
  ])(
    "installs a ready update while a check returns $status / $latest",
    async ({ status, latest, installed }) => {
      await fixture.updater.check();
      fixture.responseStatus = status;
      fixture.latest = latest;
      const check = fixture.updater.check();
      expect(await fixture.updater.install()).toBeUndefined();
      await check;
      expect(fixture.native.liveVersion).toBe(installed);
    },
  );

  test("recovers when downloading a replacement version fails", async () => {
    await fixture.updater.check();
    fixture.latest = "0.1.55";
    fixture.native.downloadFailure = "error";
    await fixture.updater.check();
    expect(fixture.status.state).toBe("error");
    fixture.native.downloadFailure = undefined;
    await fixture.updater.check();
    expect(await fixture.updater.install()).toBeUndefined();
    expect(fixture.native.liveVersion).toBe("0.1.55");
  });

  test("retries after the installer exits unsuccessfully and the old application is relaunched", async () => {
    await fixture.updater.check();
    fixture.native.installFailure = "veto";
    await fixture.updater.install();
    fixture.relaunch("0.1.53");
    fixture.native.installFailure = undefined;
    await fixture.updater.check();
    expect(await fixture.updater.install()).toBeUndefined();
    expect(fixture.native.liveVersion).toBe("0.1.54");
  });

  test("never stages a downgrade or mistakes a stale download for success", async () => {
    fixture.latest = "0.1.52";
    await fixture.updater.check();
    expect(fixture.status.state).toBe("idle");
    fixture.latest = "0.1.54";
    fixture.native.advanceDuringDownload = "0.1.52";
    expect(await fixture.updater.check()).toBeInstanceOf(Error);
    expect(fixture.status.state).toBe("error");
  });
});

class UpdateFixture {
  latest = "0.1.54";
  responseStatus = 200;
  status: AppUpdateStatus = { state: "idle" };
  readyVersions: string[] = [];
  cancelled = false;
  readonly statePath: string;
  readonly bundlePath: string;
  readonly native: NativeDriver;
  updater: MacAppUpdater;
  private readonly root: string;
  private readonly server: http.Server;
  private readonly feedUrl: string;

  private constructor(ctx: {
    root: string;
    server: http.Server;
    feedUrl: string;
  }) {
    this.root = ctx.root;
    this.server = ctx.server;
    this.feedUrl = ctx.feedUrl;
    this.statePath = path.join(ctx.root, "ShipItState.plist");
    this.bundlePath = path.join(ctx.root, "Installed.app");
    this.native = new NativeDriver(this);
    this.updater = this.createUpdater("0.1.53");
  }

  static async start() {
    const base = path.resolve(
      import.meta.dirname,
      "../../../../../tmp/updater-tests",
    );
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, "case-"));
    const server = http.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || !(address instanceof Object))
      throw new Error("No fixture address");
    const fixture = new UpdateFixture({
      root,
      server,
      feedUrl: `http://127.0.0.1:${address.port}`,
    });
    server.on("request", (_request, response) => {
      response.writeHead(fixture.responseStatus, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          name: fixture.latest,
          url: "https://example.com/Halo.zip",
        }),
      );
    });
    return fixture;
  }

  private createUpdater(version: string) {
    const updater = new MacAppUpdater({
      native: this.native,
      version,
      feedUrl: this.feedUrl,
      statePath: this.statePath,
      bundlePath: this.bundlePath,
      logger: new Logger(),
      onStatus: (status) => {
        this.status = status;
      },
      onReady: (readyVersion) => {
        this.readyVersions.push(readyVersion);
      },
      onInstallCancelled: () => {
        this.cancelled = true;
      },
    });
    updater.start();
    return updater;
  }

  relaunch(version: string) {
    this.updater.close();
    this.native.resetProcess();
    this.updater = this.createUpdater(version);
  }

  async close() {
    this.updater.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await fs.rm(this.root, { recursive: true, force: true });
  }
}

class NativeDriver extends EventEmitter {
  liveVersion = "0.1.53";
  readonly staged: string;
  downloadFailure: "error" | "throw" | "not available" | undefined;
  installFailure: "error" | "throw" | "veto" | "delayed" | undefined;
  installCalls = 0;
  advanceDuringDownload: string | undefined;
  rejectAdditionalDownloads = false;
  hold = false;
  private release: (() => void) | undefined;
  private etag: string | undefined;
  private downloadedVersion: string | undefined;
  private readonly fixture: UpdateFixture;

  constructor(fixture: UpdateFixture) {
    super();
    this.fixture = fixture;
    this.staged = path.join(
      path.dirname(fixture.statePath),
      "update.test/Halo.app",
    );
  }

  resetProcess() {
    this.etag = undefined;
    this.downloadedVersion = undefined;
  }
  setFeedURL() {
    this.etag = undefined;
  }
  checkForUpdates() {
    if (this.downloadFailure === "throw")
      throw new Error("Native start failed");
    void this.download().catch((error) => this.emit("error", error));
  }
  releaseDownload() {
    this.release?.();
  }

  private async download() {
    if (this.hold)
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    if (this.rejectAdditionalDownloads)
      throw new Error("A redundant native poll deleted the ready download");
    await fs.rm(this.staged, { recursive: true, force: true });
    const version = this.advanceDuringDownload ?? this.fixture.latest;
    // Model Squirrel remembering an ETag after deleting a staged directory.
    if (this.etag === version || this.downloadFailure === "not available") {
      this.emit("update-not-available");
      return;
    }
    this.etag = version;
    if (this.downloadFailure === "error")
      throw new Error("Download interrupted");
    await fs.mkdir(path.join(this.staged, "Contents/MacOS"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(this.staged, "Contents/MacOS/Halo"),
      "signed executable fixture",
    );
    await fs.writeFile(
      path.join(this.staged, "Contents/Info.plist"),
      JSON.stringify({
        CFBundleShortVersionString: version,
        CFBundleExecutable: "Halo",
      }),
    );
    await fs.writeFile(
      this.fixture.statePath,
      JSON.stringify({
        updateBundleURL: pathToFileURL(this.staged).href,
        targetBundleURL: pathToFileURL(this.fixture.bundlePath).href,
      }),
    );
    this.downloadedVersion = version;
    this.emit(
      "update-downloaded",
      {},
      "",
      version,
      new Date(),
      "https://example.com/Halo.zip",
    );
  }

  quitAndInstall() {
    this.installCalls += 1;
    if (this.installFailure === "throw")
      throw new Error("Installer could not start");
    if (this.installFailure === "error") {
      setImmediate(() =>
        this.emit("error", new Error("Installer failed after starting")),
      );
      return;
    }
    if (this.installFailure === "veto" || this.installFailure === "delayed")
      return;
    if (this.downloadedVersion === undefined)
      throw new Error("No native pending update");
    this.liveVersion = this.downloadedVersion;
  }
  async finishDelayedInstall() {
    // SAFETY: NativeDriver.download writes this fixture plist with a string version.
    const info = JSON.parse(
      await fs.readFile(path.join(this.staged, "Contents/Info.plist"), "utf8"),
    ) as { CFBundleShortVersionString: string };
    await fs.stat(path.join(this.staged, "Contents/MacOS/Halo"));
    this.liveVersion = info.CFBundleShortVersionString;
  }
}
