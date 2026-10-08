import { expect } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";

e2eTest.setTimeout(90_000);

e2eTest(
  "keeps workspace extensions running after Electron quits",
  async ({ app, harness, request }) => {
    const prepared = await harness.loadExtension("./fixtures/greeting");
    const extensions = await app.server.rpc.extensions.list();
    const extension = extensions.find((entry) => entry.id === prepared.id)!;
    const browser = await app.server.rpc.browser.open({ url: extension.url });
    const view = await app.server.rpc.browser.snapshot({ id: browser.id });
    expect(view.tree).toContain("Your name");

    await app.quit();

    expect((await request.get(extension.url, { timeout: 5_000 })).ok()).toBe(
      true,
    );
  },
);
