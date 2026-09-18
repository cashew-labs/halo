import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { chromium, type Page } from "playwright";
import * as errore from "errore";
import {
  createBrowserToolsForPage,
  type BorrowedPageBrowserToolkit,
  type SnapshotScreenshot,
} from "libretto-browser-tools";

const exec = promisify(execFile);

export class BrowserError extends errore.createTaggedError({
  name: "BrowserError",
  message: "Browser operation failed: $detail",
}) {}

type BrowserSession = {
  resources: errore.AsyncDisposableStack;
  page: Page;
  toolkit: BorrowedPageBrowserToolkit;
  errors: string[];
};

export class BrowserService {
  // Owns isolated browser sessions until they are closed or the service stops.
  private readonly sessions = new Map<string, BrowserSession>();
  // Shares the Chromium installation attempt across browser opens.
  private installation: Promise<void | BrowserError> | undefined;

  private async install() {
    if (existsSync(chromium.executablePath())) return;
    const require = createRequire(import.meta.url);
    const cli = join(
      dirname(require.resolve("playwright/package.json")),
      "cli.js",
    );
    const installed = await exec(
      process.execPath,
      [cli, "install", "chromium", "--no-shell"],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 180_000,
      },
    ).catch((cause) => new BrowserError({ detail: "install Chromium", cause }));
    if (installed instanceof Error) return installed;
  }

  async open(url: string) {
    if (this.installation === undefined) this.installation = this.install();
    const installed = await this.installation;
    if (installed instanceof Error) return installed;

    const browser = await chromium
      .launch({ channel: "chromium", headless: true })
      .catch((cause) => new BrowserError({ detail: "launch Chromium", cause }));
    if (browser instanceof Error) return browser;

    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await browser.close());

    const page = await browser
      .newPage({ viewport: { width: 1280, height: 800 } })
      .catch((cause) => new BrowserError({ detail: "open page", cause }));
    if (page instanceof Error) return page;

    page.setDefaultTimeout(10_000);
    const toolkit = createBrowserToolsForPage(page);
    cleanup.defer(async () => await toolkit.dispose());

    const errors: string[] = [];
    const onPageError = (error: Error) => {
      errors.push(error.message);
    };
    page.on("pageerror", onPageError);
    cleanup.defer(() => {
      page.off("pageerror", onPageError);
    });
    const loaded = await page
      .goto(url)
      .catch(
        (cause) => new BrowserError({ detail: "navigate to preview", cause }),
      );
    if (loaded instanceof Error) return loaded;
    const session = { page, toolkit, errors };
    const snapshot = await this.readSnapshot(session);
    if (snapshot instanceof Error) return snapshot;
    const id = randomUUID();
    this.sessions.set(id, { resources: cleanup.move(), ...session });
    return { id, ...snapshot };
  }

  list() {
    return [...this.sessions].map(([id, session]) => ({
      id,
      url: session.page.url(),
    }));
  }

  private get(id: string) {
    const session = this.sessions.get(id);
    if (session === undefined)
      return new BrowserError({
        detail: `Unknown browser ${id}. Use halo browser list.`,
      });
    return session;
  }

  async exec(id: string, source: string) {
    const session = this.get(id);
    if (session instanceof Error) return session;
    const result = await session.toolkit.tools.browser_exec.execute({
      sessionId: session.toolkit.sessionId,
      code: source,
    });
    if (!result.ok) return new BrowserError({ detail: result.error });
    return {
      result: result.result,
      stdout: result.stdout,
      stderr: result.stderr,
      snapshotDiff: result.snapshotDiff,
      errors: session.errors.splice(0),
    };
  }

  async snapshot(id: string) {
    const session = this.get(id);
    if (session instanceof Error) return session;
    return await this.readSnapshot(session);
  }

  private async readSnapshot({
    page,
    toolkit,
    errors,
  }: Omit<BrowserSession, "resources">) {
    const result = await toolkit.tools.browser_snapshot.execute({
      sessionId: toolkit.sessionId,
    });
    if (!result.ok) return new BrowserError({ detail: result.error });
    const title = await page
      .title()
      .catch((cause) => new BrowserError({ detail: "read page title", cause }));
    if (title instanceof Error) return title;
    return {
      url: page.url(),
      title,
      tree: result.tree,
      errors: errors.splice(0),
    };
  }

  async screenshot(id: string, workspaceRoot: string) {
    const session = this.get(id);
    if (session instanceof Error) return session;
    const result = await session.toolkit.tools.browser_snapshot.execute({
      sessionId: session.toolkit.sessionId,
      screenshot: true,
    });
    if (!result.ok) return new BrowserError({ detail: result.error });
    const directory = join(workspaceRoot, ".halo", "browser", "screenshots");
    const made = await fs
      .mkdir(directory, { recursive: true })
      .catch(
        (cause) =>
          new BrowserError({ detail: "create screenshots directory", cause }),
      );
    if (made instanceof Error) return made;
    // SAFETY: Libretto includes PNG bytes on success when screenshot: true is requested.
    const screenshot = result.screenshot as SnapshotScreenshot;
    const destination = join(directory, `${randomUUID()}.png`);
    const written = await fs
      .writeFile(destination, Buffer.from(screenshot.base64, "base64"))
      .catch((cause) => new BrowserError({ detail: "save screenshot", cause }));
    if (written instanceof Error) return written;
    return { path: destination };
  }

  async close(id: string) {
    const session = this.sessions.get(id);
    if (session === undefined)
      return new BrowserError({ detail: `Unknown browser ${id}` });
    this.sessions.delete(id);
    return await session.resources
      .disposeAsync()
      .catch((cause) => new BrowserError({ detail: "close browser", cause }));
  }

  async shutdown() {
    for (const id of this.sessions.keys()) {
      const closed = await this.close(id);
      if (closed instanceof Error) console.warn(closed);
    }
  }
}
