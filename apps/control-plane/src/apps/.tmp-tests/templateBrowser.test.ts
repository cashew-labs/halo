import { chromium } from "playwright";
import { expect, vi } from "vitest";
import { appWorldTest, signIn } from "./appWorld.js";

vi.setConfig({ testTimeout: 180_000 });

/** A real Chromium submits the listing's install form, so its Origin header is the browser's own. */
appWorldTest("a real browser installs a template from its listing", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  await owner.rpc.workspace.ensure();
  const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
  await provider.client(app.appId).extensions.writeSource({ id: "books", name: "sample-data.json", contents: "[]" });
  await owner.rpc.apps.publishTemplate({ appId: app.appId, slug: "reading", description: "Track books" });

  const recipient = await signIn({ appDataDir, origin: plane.origin, email: "reader@example.com" });
  await recipient.rpc.workspace.ensure();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const cookies = recipient.headers.get("cookie")!.split(/;\s*/).map((pair) => { const [name, ...value] = pair.split("="); return { name: name!, value: value.join("="), url: plane.origin }; });
    await context.addCookies(cookies);
    const page = await context.newPage();
    const posts: { origin?: string; status?: number }[] = [];
    page.on("response", (response) => { if (response.request().method() === "POST") posts.push({ origin: response.request().headers().origin, status: response.status() }); });
    const listing = await page.goto(`${plane.origin}/templates/reading`);
    expect(listing?.headers()["referrer-policy"]).toBe("same-origin");
    await page.getByRole("button", { name: "Install a copy" }).click();
    await expect.poll(async () => await page.locator("h1").innerText(), { timeout: 120_000 }).toContain("Installed");
    expect(posts).toEqual([{ origin: plane.origin, status: 200 }]);
    expect(await recipient.rpc.apps.list()).toMatchObject([{ extensionId: "reading", stage: "live" }]);
  } finally {
    await browser.close();
  }
});
