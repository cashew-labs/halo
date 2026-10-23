import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import * as errore from "errore";
import { chromium } from "playwright";

class TestChromeError extends errore.createTaggedError({
  name: "TestChromeError",
  message: "Test Chrome failed: $operation",
}) {}

/** Stands in for the workspace's Chrome: headless Playwright Chromium on a temporary profile. */
export class TestChrome {
  private constructor(
    private readonly root: string,
    readonly profileDir: string,
    readonly launcher: string,
  ) {}

  static async start() {
    if (!existsSync(chromium.executablePath())) {
      const cli = path.join(
        path.dirname(
          createRequire(import.meta.url).resolve("playwright/package.json"),
        ),
        "cli.js",
      );
      const installed = await promisify(execFile)(
        process.execPath,
        [cli, "install", "chromium"],
        { timeout: 180_000 },
      ).catch(
        (cause) =>
          new TestChromeError({ operation: "install Chromium", cause }),
      );
      if (installed instanceof Error) return installed;
    }
    const root = await fs
      .mkdtemp(path.join(os.tmpdir(), "halo-chrome-"))
      .catch(
        (cause) => new TestChromeError({ operation: "create profile", cause }),
      );
    if (root instanceof Error) return root;
    const profileDir = path.join(root, "profile");
    const launcher = path.join(root, "halo-chrome");
    // Mirrors the workspace launcher, with Playwright's test-only keychain flags.
    const written = await fs
      .writeFile(
        launcher,
        [
          "#!/bin/sh",
          `exec ${JSON.stringify(chromium.executablePath())} --headless=new --no-first-run --no-default-browser-check --password-store=basic --use-mock-keychain --remote-debugging-port=0 --user-data-dir=${JSON.stringify(profileDir)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      )
      .catch(
        (cause) => new TestChromeError({ operation: "write launcher", cause }),
      );
    if (written instanceof Error) return written;
    return new TestChrome(root, profileDir, launcher);
  }

  /** The workspace server config entry for this Chrome. */
  get config() {
    return { profileDir: this.profileDir, launcher: this.launcher };
  }

  /** Starts Chrome with these tabs open, as the user's desktop would. */
  async open(urls: string[]) {
    spawn(this.launcher, urls, { detached: true, stdio: "ignore" }).unref();
    const port = path.join(this.profileDir, "DevToolsActivePort");
    const deadline = Date.now() + 20_000;
    let failure: TestChromeError | undefined;
    while (Date.now() < deadline) {
      await sleep(100);
      if (existsSync(port)) {
        const address = await fs
          .readFile(port, "utf8")
          .catch(
            (cause) =>
              new TestChromeError({ operation: "read browser port", cause }),
          );
        if (address instanceof Error) {
          failure = address;
          continue;
        }
        const debugPort = address.split("\n")[0];
        if (!debugPort) continue;
        const response = await fetch(
          `http://127.0.0.1:${debugPort}/json/list`,
          { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) },
        ).catch(
          (cause) =>
            new TestChromeError({ operation: "read startup tabs", cause }),
        );
        if (response instanceof Error) {
          failure = response;
          continue;
        }
        // SAFETY: Chromium's /json/list returns target descriptors with these string fields.
        const tabs = await (
          response.json() as Promise<
            { type: string; url: string; title: string }[]
          >
        ).catch(
          (cause) =>
            new TestChromeError({ operation: "decode startup tabs", cause }),
        );
        if (tabs instanceof Error) {
          failure = tabs;
          continue;
        }
        // The port appears before startup tabs finish their first navigation.
        // Attaching Playwright in that window can miss the navigation commit.
        if (
          urls.every((url) =>
            tabs.some(
              (tab) =>
                tab.type === "page" && tab.url === url && tab.title !== "",
            ),
          )
        )
          return;
      }
    }
    return new TestChromeError({
      operation: "wait for startup tabs",
      cause: failure,
    });
  }

  async close() {
    // Chrome outlives whoever launched it, so stop it through its profile lock.
    const lock = await fs
      .readlink(path.join(this.profileDir, "SingletonLock"))
      .catch(() => undefined);
    const pid = Number(lock?.split("-").at(-1));
    if (Number.isInteger(pid)) await stop(pid);
    await fs.rm(this.root, { recursive: true, force: true });
  }
}

async function stop(pid: number) {
  const signal = (name: NodeJS.Signals | 0) =>
    errore.try({
      try: () => process.kill(pid, name),
      catch: (cause) => new TestChromeError({ operation: "signal", cause }),
    });
  if (signal("SIGTERM") instanceof Error) return;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (signal(0) instanceof Error) return;
    await sleep(100);
  }
  signal("SIGKILL");
}
