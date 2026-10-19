import { test as base, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const buildRoot = fileURLToPath(
  new URL("../../../tmp/marketing-web-test/", import.meta.url),
);
export const marketingOrigin = "http://127.0.0.1:4176";
export const marketingTest = base.extend<{ marketing: Page }>({
  marketing: async ({ page }, use) => {
    await page.route(`${marketingOrigin}/rpc/server/info**`, async (route) => {
      await route.fulfill({
        json: { json: { protocolVersion: 6, supportedProtocols: [6] } },
      });
    });
    await page.route(`${marketingOrigin}/rpc/auth/session**`, async (route) => {
      await route.fulfill({ json: { json: { status: "signed-out" } } });
    });
    await page.route(
      "https://www.googletagmanager.com/gtag/js**",
      async (route) => {
        await route.fulfill({
          contentType: "text/javascript",
          body: "/* Test stream: retain the Google tag queue without sending data. */",
        });
      },
    );
    await page.route("https://app.cal.com/embed/embed.js", async (route) => {
      const source = await readFile(
        new URL(
          "../../../node_modules/@calcom/embed-core/dist/embed/embed.js",
          import.meta.url,
        ),
        "utf8",
      );
      await route.fulfill({ contentType: "text/javascript", body: source });
    });
    await page.route("https://app.cal.com/**", async (route) => {
      if (route.request().resourceType() !== "document") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>Test booking provider</title><button id="book">Book test call</button><script>
        parent.postMessage({fullType:'CAL:halo-early-access:__iframeReady',data:{}},'*');
        document.getElementById('book').onclick=()=>parent.postMessage({fullType:'CAL:halo-early-access:bookingSuccessfulV2',data:{uid:'test-booking',status:'ACCEPTED'}},'*');
      </script>`,
      });
    });
    if (process.env.REVIEW_COVERAGE_DIR)
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    if (process.env.REVIEW_COVERAGE_DIR) {
      const entries = (await page.coverage.stopJSCoverage())
        .filter((entry) => entry.url.startsWith(`${marketingOrigin}/assets/`))
        .map((entry) => ({
          ...entry,
          url: pathToFileURL(path.join(buildRoot, new URL(entry.url).pathname))
            .href,
        }));
      await writeFile(
        path.join(process.env.REVIEW_COVERAGE_DIR, `${randomUUID()}.json`),
        JSON.stringify(entries),
      );
    }
  },
});

export async function marketingEvents(page: Page) {
  return await page.evaluate(() => {
    // SAFETY: Google's standard queue contains the arguments passed by the site.
    const analytics = window as Window & { dataLayer?: IArguments[] };
    return (analytics.dataLayer ?? []).map((entry) => Array.from(entry));
  });
}
