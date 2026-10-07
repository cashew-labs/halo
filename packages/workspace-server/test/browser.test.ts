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
