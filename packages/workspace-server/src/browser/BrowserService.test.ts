import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import * as errore from "errore";
import { BrowserService } from "./BrowserService.js";

const browserTest = test.extend<{ profile: string; browser: BrowserService }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest requires destructured fixture arguments.
  profile: async ({}, use) => {
    const parent = path.resolve(import.meta.dirname, "../../../../tmp/browser");
    await fs.mkdir(parent, { recursive: true });
    const profile = await fs.mkdtemp(path.join(parent, "inventory-"));
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await fs.rm(profile, { recursive: true }));
    await use(profile);
  },
  browser: async ({ profile }, use) => {
    const browser = new BrowserService({
      chrome: { profileDir: profile, launcher: "unused" },
      workspaceRoot: profile,
    });
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await browser.shutdown());
    await use(browser);
  },
});

browserTest(
  "reports cancellation rather than empty inventory when no endpoint is available",
  async ({ browser, profile }) => {
    for (const endpoint of [undefined, "incomplete\n"]) {
      if (endpoint !== undefined)
        await fs.writeFile(path.join(profile, "DevToolsActivePort"), endpoint);
      expect(await browser.tabs()).toEqual([]);
      for (const alreadyAborted of [true, false]) {
        const controller = new AbortController();
        if (alreadyAborted) controller.abort();
        const pending = browser.tabs({ signal: controller.signal });
        // tabs has yielded to the asynchronous address read, but it cannot yet
        // have returned its result. Cancel without mocking filesystem internals.
        if (!alreadyAborted) controller.abort();
        const result = await pending;
        expect(result).toBeInstanceOf(Error);
        expect(errore.isAbortError(result)).toBe(true);
        expect(result).toMatchObject({ cause: controller.signal.reason });
      }
    }
  },
);
