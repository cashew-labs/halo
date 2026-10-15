import { chromium } from "playwright";
import { expect, vi } from "vitest";
import { appWorldTest, signIn } from "./appWorld.js";

vi.setConfig({ testTimeout: 120_000 });

/** A real Chromium submits the consent form, so its Origin header is the browser's own. */
appWorldTest("a real browser completes owner and member sign-in on a creator host", async ({ appDataDir, plane }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "invited", members: ["friend@example.com"] } });
  const creator = new URL(app.url).origin;
  const browser = await chromium.launch();
  try {
    for (const person of [{ email: "creator@example.com", headers: owner.headers, role: "owner" }, { email: "friend@example.com", headers: (await signIn({ appDataDir, origin: plane.origin, email: "friend@example.com" })).headers, role: "member" }]) {
      const context = await browser.newContext();
      const cookies = person.headers.get("cookie")!.split(/;\s*/).map((pair) => { const [name, ...value] = pair.split("="); return { name: name!, value: value.join("="), url: plane.origin }; });
      await context.addCookies(cookies);
      const page = await context.newPage();
      const posts: (string | undefined)[] = [];
      page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/apps/handoff")) posts.push(request.headers().origin); });
      // An invited app sends the visitor to sign in; the consent page shows who signs in.
      await page.goto(`${creator}/books/view/`);
      await expect.poll(() => page.url()).toContain("/api/apps/handoff?");
      expect(await page.locator("h1").innerText()).toContain(person.email);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.waitForURL(`${creator}/books/view/`);
      expect(posts).toEqual([plane.origin]);
      const viewer = await page.evaluate(async () => {
        const response = await fetch("/books/api/viewer", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        return { status: response.status, body: await response.json() };
      });
      expect(viewer).toMatchObject({ status: 200, body: { json: { role: person.role, email: person.email } } });
      // Halo's Open link signs in again; with a session for this host it goes straight to the app.
      const reopened = await page.goto(`${creator}/__halo/signin?return=%2Fbooks%2Fview%2F`);
      expect(page.url()).toBe(`${creator}/books/view/`);
      expect(reopened?.request().redirectedFrom()?.url()).toBe(`${creator}/__halo/signin?return=%2Fbooks%2Fview%2F`);
      await context.close();
    }
    // A browser with a creator-host cookie that names no session still goes through the handoff.
    const stale = await browser.newContext();
    await stale.addCookies([{ name: "halo-session", value: "x".repeat(43), url: creator }]);
    const stalePage = await stale.newPage();
    await stalePage.goto(`${creator}/__halo/signin?return=%2Fbooks%2Fview%2F`);
    expect(stalePage.url()).toContain(`${plane.origin}/api/apps/handoff?`);
    await stale.close();
  } finally {
    await browser.close();
  }
});
