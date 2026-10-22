import { setTimeout as sleep } from "node:timers/promises";
import { expect } from "vitest";
import * as errore from "errore";
import { m } from "@get-halo/shared/testing";
import { TestChrome } from "@get-halo/workspace-server/testing";
import { serverTest } from "./serverTest.js";

const browserTest = serverTest.extend<{ chrome: TestChrome }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixture callbacks require destructured parameters.
  chrome: async ({}, use) => {
    const chrome = await TestChrome.start();
    if (chrome instanceof Error) throw chrome;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await chrome.close());
    await use(chrome);
  },
});

const form = `data:text/html,${encodeURIComponent(`
  <!doctype html><title>Signup</title>
  <label>Email <input aria-label="Email address"></label>
  <button onclick="this.textContent = 'Saved'">Save draft</button>
  <ul><li>One</li><li>Two</li></ul>
`)}`;
const userTab = `data:text/html,${encodeURIComponent("<title>Inbox</title><p>Mail</p>")}`;

type Tab = { id: string; url: string; title: string };

browserTest(
  "drives a tab in the workspace Chrome through browser tools",
  async ({ createServer, chrome }) => {
    expect(await chrome.open([userTab])).toBeUndefined();
    const server = createServer({ chrome: chrome.config });
    await server.start();
    const call = async (
      page: string,
      chain: unknown[],
      method: string,
      args: unknown[] = [],
    ) =>
      // SAFETY: browser.call returns { value, url }.
      (
        (await server.rpc.testApi.invokeTool({
          path: "browser.call",
          input: { page, chain, method, args },
        })) as {
          value: unknown;
        }
      ).value;

    // SAFETY: browser.newPage returns the opened tab.
    const opened = (await server.rpc.testApi.invokeTool({
      path: "browser.newPage",
      input: { url: form },
    })) as Tab;
    expect(opened).toMatchObject({ title: "Signup" });

    const snapshot = await call(opened.id, [], "snapshot");
    const ref = /button "Save draft" \[ref=(\w+)\]/.exec(String(snapshot))?.[1];
    await call(opened.id, [["locator", [`aria-ref=${ref}`]]], "click");
    expect(
      await call(opened.id, [["getByRole", ["button"]]], "innerText"),
    ).toBe("Saved");

    const email = [
      ["getByRole", ["textbox", { name: { $regexp: "email", flags: "i" } }]],
    ];
    await call(opened.id, email, "fill", ["ada@example.com"]);
    expect(await call(opened.id, email, "inputValue")).toBe("ada@example.com");
    expect(
      await call(opened.id, [], "evaluate", [
        {
          $function: "(selector) => document.querySelectorAll(selector).length",
        },
        "li",
      ]),
    ).toBe(2);

    // An older snapshot's refs fail instead of acting on whatever they now name.
    await call(opened.id, [], "snapshot");
    await expect(
      call(opened.id, [["locator", [`aria-ref=${ref}`]]], "click"),
    ).rejects.toThrow(/latest snapshot/);

    // SAFETY: browser.tabs returns the open tabs.
    const tabs = (await server.rpc.testApi.invokeTool({
      path: "browser.tabs",
      input: {},
    })) as Tab[];
    const inbox = tabs.find((tab) => tab.title === "Inbox")!;
    expect(tabs).toContainEqual(expect.objectContaining({ id: opened.id }));

    // Page code must never receive Playwright's own objects: with them and
    // exposeFunctions it could call Playwright's protocol dispatcher.
    const escape = `(page) => page._connection.onmessage({ id: 1, guid: page._guid, method: "close", params: {}, metadata: {} })`;
    await expect(
      call(inbox.id, [], "evaluate", [
        { $function: escape },
        { $locator: { page: inbox.id, chain: [["locator", ["body"]]] } },
        { exposeFunctions: true },
      ]),
    ).rejects.toThrow(/at most 2 arguments/);
    await expect(
      call(inbox.id, [], "evaluate", [
        { $function: escape },
        { $locator: { page: inbox.id, chain: [["locator", ["body"]]] } },
      ]),
    ).rejects.toThrow(/\$locator is accepted only/);
    await expect(
      call(inbox.id, [["locator", ["body"]]], "evaluate", [
        { $function: "(body) => body.textContent" },
        { $undefined: true },
        { exposeFunctions: true },
      ]),
    ).rejects.toThrow(/unsupported options exposeFunctions/);
    await server.rpc.testApi.invokeTool({
      path: "browser.close",
      input: { page: opened.id },
    });
    // SAFETY: browser.tabs returns the open tabs.
    const remaining = (await server.rpc.testApi.invokeTool({
      path: "browser.tabs",
      input: {},
    })) as Tab[];
    expect(remaining.map((tab) => tab.title)).toEqual(["Inbox"]);
  },
);

browserTest(
  "keeps the user's tabs reachable by ID after the server restarts",
  async ({ createServer, chrome }) => {
    expect(await chrome.open([userTab])).toBeUndefined();
    const server = createServer({ chrome: chrome.config });
    await server.start();
    const tabs = async () =>
      // SAFETY: browser.tabs returns the open tabs.
      (await server.rpc.testApi.invokeTool({
        path: "browser.tabs",
        input: {},
      })) as Tab[];
    const [inbox] = await tabs();

    await server.stop();
    await server.start();

    expect(await tabs()).toEqual([inbox]);
    expect(
      await server.rpc.testApi.invokeTool({
        path: "browser.call",
        input: {
          page: inbox!.id,
          chain: [["getByText", ["Mail"]]],
          method: "count",
          args: [],
        },
      }),
    ).toMatchObject({ value: 1 });
  },
);

browserTest(
  "stopping a run stops its waiting browser action",
  async ({ createServer, chrome, llm }) => {
    const server = createServer({ chrome: chrome.config });
    await server.start();
    // The button appears late, so the click waits for it.
    const late = `data:text/html,${encodeURIComponent(`
      <title>Waiting</title>
      <script>setTimeout(() => {
        const button = document.createElement("button");
        button.textContent = "Late";
        button.onclick = () => (document.title = "Clicked");
        document.body.append(button);
      }, 2500)</script>
    `)}`;
    // SAFETY: browser.newPage returns the opened tab.
    const tab = (await server.rpc.testApi.invokeTool({
      path: "browser.newPage",
      input: { url: late },
    })) as Tab;
    const session = await server.rpc.thread.new();
    const run = server.promptAndWait({ ...session, text: "Click Late" });
    await llm.respond(
      m.tool.start("exec", {
        id: "click",
        arguments: {
          js: `await tools["browser.call"](${JSON.stringify({
            page: tab.id,
            chain: [["getByRole", ["button", { name: "Late" }]]],
            method: "click",
            args: [],
          })})`,
        },
      }),
    );
    await sleep(500);
    await server.rpc.thread.abort(session);
    await run;

    // Give the click time to fire had it kept waiting.
    await sleep(3000);
    expect(
      await server.rpc.testApi.invokeTool({
        path: "browser.call",
        input: { page: tab.id, chain: [], method: "title", args: [] },
      }),
    ).toMatchObject({ value: "Waiting" });
  },
);

browserTest(
  "exec drives the browser with Playwright pages and locators",
  async ({ createServer, chrome, llm }) => {
    const server = createServer({ chrome: chrome.config });
    await server.start();
    const url = `data:text/html,${encodeURIComponent(`
      <title>Groceries</title>
      <ul><li>Apple</li><li>Banana</li></ul>
      <button onclick="this.textContent = 'Saved'">Save draft</button>
    `)}`;
    const session = await server.rpc.thread.new();
    const run = server.promptAndWait({ ...session, text: "Save the draft" });
    await llm.respond(
      m.tool.start("exec", {
        id: "browse",
        arguments: {
          js: `var page = await tools.browser.newPage({ url: ${JSON.stringify(url)} })
await page.getByRole("button", { name: /save/i }).click()
var lists = await page.locator("ul").filter({ has: page.getByText("Banana") }).count()
var items = await page.evaluate((selector) => document.querySelectorAll(selector).length, "li")
var missing = await page.getByText("Checkout").click({ timeout: 200 }).then(() => "clicked", (error) => error.message)
await page.screenshot()
;({ saved: await page.getByRole("button").innerText(), lists, items, missing })`,
        },
      }),
    );
    let request: unknown;
    await llm.respond(async (body) => {
      request = body;
      return m.assistant("Saved.");
    });
    await run;
    // SAFETY: the LLM driver receives Chat Completions requests.
    const { messages } = request as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const output = messages.find((message) => message.role === "tool")!;
    // SAFETY: an exec tool message holds the JSON text of the cell's final expression.
    const result = JSON.parse(String(output.content)) as {
      saved: string;
      lists: number;
      items: number;
      missing: string;
    };
    expect(result).toMatchObject({ saved: "Saved", lists: 1, items: 2 });
    // Unlike other runtime tools, browser methods throw, with Playwright's message.
    expect(result.missing).toMatch(/Timeout 200ms exceeded/);
    // screenshot() attaches the image for the model, as viewImage does.
    expect(JSON.stringify(messages)).toContain("data:image/png;base64,");
  },
);

browserTest(
  "requires the workspace.browser capability",
  async ({ createServer, chrome }) => {
    const server = createServer({
      chrome: chrome.config,
      agentCapabilities: [],
    });
    await server.start();
    await expect(
      server.rpc.testApi.invokeTool({ path: "browser.tabs", input: {} }),
    ).rejects.toThrow(/workspace\.browser/);
  },
);
