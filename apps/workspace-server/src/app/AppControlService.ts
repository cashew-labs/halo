import { chromium } from "playwright";
import * as errore from "errore";
import { BrowserError, BrowserPage } from "../browser/BrowserPage.js";
import { captureScreenshot } from "../browser/captureScreenshot.js";

export type AppBrowserTarget = { cdpUrl: string; pageUrl: string };

export class AppControlService {
  private readonly target: AppBrowserTarget | undefined;

  constructor(ctx: { target: AppBrowserTarget | undefined }) {
    const { target } = ctx;
    this.target = target;
  }

  async exec(source: string) {
    return await this.withPage(async (view) => await view.exec(source));
  }

  async snapshot() {
    return await this.withPage(async (view) => await view.snapshot());
  }

  async screenshot(workspaceRoot: string) {
    return await this.withPage(
      async (view) => await captureScreenshot({ view, workspaceRoot }),
    );
  }

  private async withPage<T>(run: (view: BrowserPage) => Promise<T>) {
    if (this.target === undefined)
      return new BrowserError({
        detail: "halo app requires a running Halo debug app",
      });
    // Playwright's default media overrides otherwise flash Halo's system theme on attach.
    const browser = await chromium
      .connectOverCDP(this.target.cdpUrl, { noDefaults: true })
      .catch(
        (cause) =>
          new BrowserError({ detail: "connect to Halo debugger", cause }),
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
      return new BrowserError({ detail: "Halo renderer is not open" });
    const view = new BrowserPage(page);
    cleanup.defer(async () => await view.dispose());
    return await run(view);
  }
}
