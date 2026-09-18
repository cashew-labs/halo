import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";
import * as errore from "errore";
import {
  createBrowserToolsForPage,
  type BorrowedPageBrowserToolkit,
  type SnapshotScreenshot,
} from "libretto-browser-tools";

class AppControlError extends errore.createTaggedError({
  name: "AppControlError",
  message: "App control failed: $detail",
}) {}

export type AppBrowserTarget = { cdpUrl: string; pageUrl: string };

export class AppControlService {
  private readonly target: AppBrowserTarget;
  private readonly screenshotDirectory: string;

  constructor(ctx: { target: AppBrowserTarget; screenshotDirectory: string }) {
    const { target, screenshotDirectory } = ctx;
    this.target = target;
    this.screenshotDirectory = screenshotDirectory;
  }

  async exec(source: string) {
    return await this.withPage(async ({ toolkit, errors }) => {
      const result = await toolkit.tools.browser_exec.execute({
        sessionId: toolkit.sessionId,
        code: source,
      });
      if (!result.ok) return new AppControlError({ detail: result.error });
      return {
        result: result.result,
        stdout: result.stdout,
        stderr: result.stderr,
        snapshotDiff: result.snapshotDiff,
        errors: errors.splice(0),
      };
    });
  }

  async snapshot() {
    return await this.withPage(async ({ page, toolkit, errors }) => {
      const result = await toolkit.tools.browser_snapshot.execute({
        sessionId: toolkit.sessionId,
      });
      if (!result.ok) return new AppControlError({ detail: result.error });
      const title = await page
        .title()
        .catch(
          (cause) => new AppControlError({ detail: "read page title", cause }),
        );
      if (title instanceof Error) return title;
      return {
        url: page.url(),
        title,
        tree: result.tree,
        errors: errors.splice(0),
      };
    });
  }

  async screenshot() {
    return await this.withPage(async ({ toolkit }) => {
      const result = await toolkit.tools.browser_snapshot.execute({
        sessionId: toolkit.sessionId,
        screenshot: true,
      });
      if (!result.ok) return new AppControlError({ detail: result.error });
      const made = await fs
        .mkdir(this.screenshotDirectory, { recursive: true })
        .catch(
          (cause) =>
            new AppControlError({
              detail: "create screenshots directory",
              cause,
            }),
        );
      if (made instanceof Error) return made;
      // SAFETY: Libretto includes PNG bytes on success when screenshot: true is requested.
      const screenshot = result.screenshot as SnapshotScreenshot;
      const destination = path.join(
        this.screenshotDirectory,
        `${crypto.randomUUID()}.png`,
      );
      const written = await fs
        .writeFile(destination, Buffer.from(screenshot.base64, "base64"))
        .catch(
          (cause) => new AppControlError({ detail: "save screenshot", cause }),
        );
      if (written instanceof Error) return written;
      return { path: destination };
    });
  }

  private async withPage<T>(
    run: (ctx: {
      page: Page;
      toolkit: BorrowedPageBrowserToolkit;
      errors: string[];
    }) => Promise<T>,
  ) {
    // Playwright's default media overrides otherwise flash Halo's system theme on attach.
    const browser = await chromium
      .connectOverCDP(this.target.cdpUrl, { noDefaults: true })
      .catch(
        (cause) =>
          new AppControlError({ detail: "connect to Halo debugger", cause }),
      );
    if (browser instanceof Error) return browser;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await browser.close());
    const url = this.target.pageUrl;
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith(url));
    if (page === undefined)
      return new AppControlError({ detail: "Halo renderer is not open" });
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
    return await run({ page, toolkit, errors });
  }
}
