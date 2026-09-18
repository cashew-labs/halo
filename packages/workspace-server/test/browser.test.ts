import { expect } from "vitest";
import { serverTest } from "./serverTest.js";

const url = `data:text/html,${encodeURIComponent(`
  <!doctype html><title>Browser playground</title>
  <label>Draft <input aria-label="Draft"></label>
  <button onclick="this.textContent = 'Saved'">Save</button>
`)}`;

serverTest(
  "keeps the live page across separate browser commands",
  async ({ server }) => {
    const browser = await server.rpc.browser.open({ url });
    await server.rpc.browser.exec({
      id: browser.id,
      source: `await page.getByRole('textbox', { name: 'Draft' }).fill('Shopping list');`,
    });
    const read = await server.rpc.browser.exec({
      id: browser.id,
      source: `return await page.getByRole('textbox', { name: 'Draft' }).inputValue();`,
    });
    expect(read.result).toBe("Shopping list");
  },
);

serverTest(
  "opens independent views for two collaborators",
  async ({ server }) => {
    const first = await server.rpc.browser.open({ url });
    const second = await server.rpc.browser.open({ url });
    await server.rpc.browser.exec({
      id: first.id,
      source: `await page.getByRole('textbox', { name: 'Draft' }).fill('Private draft');`,
    });
    const other = await server.rpc.browser.exec({
      id: second.id,
      source: `return await page.getByRole('textbox', { name: 'Draft' }).inputValue();`,
    });
    expect(other.result).toBe("");
  },
);

serverTest(
  "reports the visible result of an action in a snapshot",
  async ({ server }) => {
    const browser = await server.rpc.browser.open({ url });
    await server.rpc.browser.exec({
      id: browser.id,
      source: `await page.getByRole('button', { name: 'Save', exact: true }).click();`,
    });
    const snapshot = await server.rpc.browser.snapshot({ id: browser.id });
    expect(snapshot.tree).toContain("Saved");
  },
);

serverTest(
  "saves a browser screenshot the workspace can read",
  async ({ server }) => {
    const browser = await server.rpc.browser.open({ url });
    const screenshot = await server.rpc.browser.screenshot({ id: browser.id });
    const bytes = await server.harness.files.read(screenshot.path);
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  },
);

serverTest(
  "closes a browser without closing another collaborator",
  async ({ server }) => {
    const first = await server.rpc.browser.open({ url });
    const second = await server.rpc.browser.open({ url });
    await server.rpc.browser.close({ id: first.id });
    expect(await server.rpc.browser.list()).toEqual([{ id: second.id, url }]);
  },
);

serverTest(
  "keeps browser control on the CLI connection",
  async ({ server }) => {
    await expect(server.rendererRpc.browser.open({ url })).rejects.toThrow(
      "Browser control requires the Halo CLI connection",
    );
  },
);
