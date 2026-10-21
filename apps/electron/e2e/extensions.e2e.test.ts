import { expect } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";

e2eTest.setTimeout(90_000);

e2eTest(
  "keeps workspace extensions running after Electron quits",
  async ({ app, harness, server }) => {
    const prepared = await harness.loadExtension("./fixtures/greeting");
    const extensions = await app.server.rpc.extensions.list();
    const extension = extensions.find((entry) => entry.id === prepared.id)!;
    // The extension accepts only the workspace's authenticated requests, so
    // check it through a tab an agent opened in the workspace Chrome.
    const opened = await server.rpc.testApi.invokeTool({
      path: "browser.newPage",
      input: { url: extension.url },
    });
    // SAFETY: browser.newPage returns the opened tab.
    const tab = opened as { id: string };
    const call = async (method: string) =>
      // SAFETY: browser.call returns { value, url }.
      (
        (await server.rpc.testApi.invokeTool({
          path: "browser.call",
          input: { page: tab.id, chain: [], method, args: [] },
        })) as { value: unknown }
      ).value;
    expect(await call("snapshot")).toContain("Your name");

    await app.quit();

    await call("reload");
    expect(await call("snapshot")).toContain("Your name");
    await server.rpc.testApi.invokeTool({
      path: "browser.close",
      input: { page: tab.id },
    });
  },
);
