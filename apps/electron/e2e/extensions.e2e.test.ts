import { expect } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";

e2eTest.setTimeout(90_000);

e2eTest(
  "keeps workspace extensions running after Electron quits",
  async ({ app, harness, server }) => {
    const prepared = await harness.loadExtension("./fixtures/greeting");
    const extensions = await app.server.rpc.extensions.list();
    const extension = extensions.find((entry) => entry.id === prepared.id)!;
    const browser = await app.server.rpc.browser.open({ url: extension.url });
    const view = await app.server.rpc.browser.snapshot({ id: browser.id });
    expect(view.tree).toContain("Your name");

    await app.quit();

    // The extension still answers its listed URL; it accepts only the
    // workspace's authenticated requests, so check through its browser.
    const reopened = await server.rpc.browser.open({ url: extension.url });
    const after = await server.rpc.browser.snapshot({ id: reopened.id });
    expect(after.tree).toContain("Your name");
    await server.rpc.browser.close({ id: reopened.id });
  },
);
