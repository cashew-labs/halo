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

e2eTest(
  "keeps a newly loaded extension reachable across concurrent reloads",
  async ({ app, harness }) => {
    const loaded = await harness.loadExtension("./fixtures/greeting");
    const extensions = await app.server.rpc.extensions.list();
    const extension = extensions.find((entry) => entry.id === loaded.id)!;
    const browser = await app.server.rpc.browser.open({ url: extension.url });

    await Promise.all([
      app.server.rpc.extensions.reload(),
      app.server.rpc.extensions.reload(),
    ]);

    const view = await app.server.rpc.browser.exec({
      id: browser.id,
      source: `
        await page.reload();
        await page.getByRole("textbox", { name: "Your name" }).waitFor();
        return await page.getByRole("textbox", { name: "Your name" }).isVisible();
      `,
    });
    expect(view.result).toBe(true);
    expect(await app.server.rpc.extensions.list()).toEqual([extension]);
  },
);
