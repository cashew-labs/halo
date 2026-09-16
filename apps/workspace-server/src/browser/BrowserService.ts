import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import * as errore from "errore";
import { BrowserError, BrowserPage } from "./BrowserPage.js";
import { captureScreenshot } from "./captureScreenshot.js";

const exec = promisify(execFile);

type BrowserSession = {
  resources: errore.AsyncDisposableStack;
  view: BrowserPage;
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
    const view = new BrowserPage(page);
    cleanup.defer(async () => await view.dispose());
    const loaded = await page
      .goto(url)
      .catch(
        (cause) => new BrowserError({ detail: "navigate to preview", cause }),
      );
    if (loaded instanceof Error) return loaded;
    const snapshot = await view.snapshot();
    if (snapshot instanceof Error) return snapshot;
    const id = randomUUID();
    this.sessions.set(id, { resources: cleanup.move(), view });
    return { id, ...snapshot };
  }

  list() {
    return [...this.sessions].map(([id, session]) => ({
      id,
      url: session.view.page.url(),
    }));
  }

  private get(id: string) {
    const session = this.sessions.get(id);
    if (session === undefined)
      return new BrowserError({
        detail: `Unknown browser ${id}. Use halo browser list.`,
      });
    return session.view;
  }

  async exec(id: string, source: string) {
    const view = this.get(id);
    if (view instanceof Error) return view;
    return await view.exec(source);
  }

  async snapshot(id: string) {
    const view = this.get(id);
    if (view instanceof Error) return view;
    return await view.snapshot();
  }

  async screenshot(id: string, workspaceRoot: string) {
    const view = this.get(id);
    if (view instanceof Error) return view;
    return await captureScreenshot({ view, workspaceRoot });
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
