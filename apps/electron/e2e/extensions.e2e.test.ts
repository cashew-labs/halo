import { request } from "node:http";
import { expect } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";

e2eTest.setTimeout(90_000);

e2eTest(
  "keeps workspace extensions running after Electron quits",
  async ({ app, harness, server }) => {
    const prepared = await harness.loadExtension("./fixtures/greeting");
    const extensions = await app.server.rpc.extensions.list();
    const extension = extensions.find((entry) => entry.id === prepared.id)!;
    // An agent's tab in the workspace Chrome loads the extension's direct URL
    // with no Halo headers; the extension trusts direct loopback requests.
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

    // The workspace's own processes reach the loopback port as the owner, but
    // not through a rebound hostname or from another site's page.
    const status = async (headers: Record<string, string>) =>
      await new Promise<number | undefined>((resolve) => {
        request(extension.url, { headers }, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
          .once("error", () => resolve(undefined))
          .end();
      });
    expect(await status({})).toBe(200);
    expect(await status({ host: "attacker.example" })).toBe(401);
    expect(await status({ "sec-fetch-site": "cross-site" })).toBe(401);
  },
);
