import fs from "node:fs/promises";
import nodeHttp from "node:http";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { expect } from "vitest";
import WebSocket from "ws";
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
// Escaped metadata exceeds the cap, but the visible title does not.
const userTitle = `Inbox & <Notes> "Quotes" 'Apostrophe' &amp; &#39; Ω ${"&".repeat(500)}`;
const userTab = `data:text/html,${encodeURIComponent(`<meta charset="utf-8"><p>Mail</p><script>document.title = ${JSON.stringify(userTitle)}</script>`)}`;

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
    // Playwright pastes nth's argument into the selector; it cannot carry a raw ref.
    await expect(
      call(
        opened.id,
        [
          ["locator", ["body"]],
          ["nth", [`0 >> aria-ref=${ref!.replace(/^s\d+/, "")}`]],
        ],
        "click",
      ),
    ).rejects.toThrow(/unsupported arguments for nth/);

    // SAFETY: browser.tabs returns the open tabs.
    const tabs = (await server.rpc.testApi.invokeTool({
      path: "browser.tabs",
      input: {},
    })) as Tab[];
    const inbox = tabs.find((tab) => tab.url === userTab)!;
    expect(inbox.title).toBe(userTitle);
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
    expect(remaining.map((tab) => tab.title)).toEqual([userTitle]);
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
      <button onclick="this.textContent = confirm('Place order?') ? 'Placed' : 'Kept'">Order</button>
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
await page.getByRole("button", { name: "Order" }).click()
var dismissed = await page.getByRole("button").last().innerText()
page.handleDialogs("accept")
await page.getByRole("button").last().click()
var accepted = await page.getByRole("button").last().innerText()
await page.screenshot({ path: "shots/page.png" })
;({ saved: await page.getByRole("button").first().innerText(), lists, items, missing, dismissed, accepted })`,
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
    // The cell's final expression comes first, then its console logs.
    const [json, logs] = String(output.content).split("\nLogs:\n");
    // SAFETY: an exec tool message holds the JSON text of the cell's final expression.
    const result = JSON.parse(json!) as {
      saved: string;
      lists: number;
      items: number;
      missing: string;
    };
    // Dialogs are dismissed until the page object asks to accept them.
    expect(result).toMatchObject({
      saved: "Saved",
      lists: 1,
      items: 2,
      dismissed: "Kept",
      accepted: "Placed",
    });
    expect(logs).toContain('Dismissed browser confirm dialog: "Place order?"');
    expect(logs).toContain('Accepted browser confirm dialog: "Place order?"');
    // Unlike other runtime tools, browser methods throw, with Playwright's message.
    expect(result.missing).toMatch(/Timeout 200ms exceeded/);
    // screenshot() attaches the image for the model, as viewImage does,
    // and saves it where the agent asked.
    expect(JSON.stringify(messages)).toContain("data:image/png;base64,");
    const saved = await fs.readFile(
      path.join(server.workspaceRoot, "shots", "page.png"),
    );
    expect(saved.subarray(1, 4).toString()).toBe("PNG");
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

browserTest(
  "releases idle tab debuggers without closing tabs or reconnecting for inventory",
  { timeout: 90_000 },
  async ({ createServer, chrome }) => {
    const server = createServer({ chrome: chrome.config });
    await server.start();
    // SAFETY: browser.newPage returns the opened tab.
    const tab = (await server.rpc.testApi.invokeTool({
      path: "browser.newPage",
      input: { url: form },
    })) as Tab;
    const call = async (method: string, args: unknown[] = []) =>
      await server.rpc.testApi.invokeTool({
        path: "browser.call",
        input: { page: tab.id, chain: [], method, args },
      });
    await call("evaluate", [
      { $function: "() => { window.haloDraft = 'keep this draft'; }" },
    ]);
    // Read attachment state through a browser-only CDP socket. A second
    // Playwright connection would itself attach debuggers to every page.
    const targets = async () => {
      const address = await fs.readFile(
        path.join(chrome.profileDir, "DevToolsActivePort"),
        "utf8",
      );
      const [port, browserPath] = address.trim().split("\n");
      const socket = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
      using cleanup = new errore.DisposableStack();
      cleanup.defer(() => socket.close());
      const signal = AbortSignal.timeout(5_000);
      await once(socket, "open", { signal });
      const message = once(socket, "message", { signal });
      socket.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
      const [data] = await message;
      // SAFETY: Target.getTargets returns CDP target descriptors.
      const response = JSON.parse(String(data)) as {
        result: {
          targetInfos: Array<{ targetId: string; attached: boolean }>;
        };
      };
      return response.result.targetInfos;
    };
    expect(await targets()).toContainEqual(
      expect.objectContaining({ targetId: tab.id, attached: true }),
    );
    await expect
      .poll(
        async () => (await targets()).find((item) => item.targetId === tab.id),
        { timeout: 65_000, interval: 500 },
      )
      .toMatchObject({ attached: false });

    // Listing must not reconnect or wake idle tabs.
    expect(
      await server.rpc.testApi.invokeTool({ path: "browser.tabs", input: {} }),
    ).toContainEqual(tab);
    expect(await targets()).toContainEqual(
      expect.objectContaining({ targetId: tab.id, attached: false }),
    );
    // The same tab and its unsaved page state survive idle release.
    expect(
      await call("evaluate", [{ $function: "() => window.haloDraft" }]),
    ).toMatchObject({ value: "keep this draft" });
    await call("snapshot");
  },
);

browserTest(
  "dismisses a dialog opened between calls after the idle interval",
  { timeout: 140_000 },
  async ({ createServer, chrome }) => {
    const server = createServer({ chrome: chrome.config });
    await server.start();
    // SAFETY: browser.newPage returns the opened tab.
    const tab = (await server.rpc.testApi.invokeTool({
      path: "browser.newPage",
      input: { url: form },
    })) as Tab;
    await server.rpc.testApi.invokeTool({
      path: "browser.call",
      input: {
        page: tab.id,
        chain: [],
        method: "evaluate",
        args: [
          {
            $function:
              "() => { setTimeout(() => { window.haloAnswer = confirm('Keep draft?'); }, 500); }",
          },
        ],
      },
    });
    await sleep(65_000);
    expect(
      await server.rpc.testApi.invokeTool({
        path: "browser.call",
        input: {
          page: tab.id,
          chain: [],
          method: "evaluate",
          args: [{ $function: "() => window.haloAnswer" }],
        },
      }),
    ).toMatchObject({
      value: false,
      dialogs: [{ type: "confirm", message: "Keep draft?", accepted: false }],
    });
  },
);

browserTest(
  "does not report another browser's inventory from a reused DevTools port",
  async ({ createServer, chrome }) => {
    const tab = {
      id: "unrelated",
      type: "page",
      url: "https://example.com/",
      title: "Unrelated",
    };
    const identity = { path: "/devtools/browser/another-browser" };
    const decoy = nodeHttp.createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/json/version"
            ? { webSocketDebuggerUrl: `ws://127.0.0.1:${port}${identity.path}` }
            : [tab],
        ),
      );
    });
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      decoy.closeAllConnections();
      await new Promise<void>((resolve) => decoy.close(() => resolve()));
    });
    decoy.listen({ host: "127.0.0.1", port: 0 });
    await once(decoy, "listening");
    // SAFETY: listening TCP servers have an address with an allocated port.
    const { port } = decoy.address() as { port: number };
    await fs.mkdir(chrome.profileDir, { recursive: true });
    await fs.writeFile(
      path.join(chrome.profileDir, "DevToolsActivePort"),
      `${port}\n/devtools/browser/inventory\n`,
    );
    const server = createServer({ chrome: chrome.config });
    await server.start();
    const tabs = async () =>
      await server.rpc.testApi.invokeTool({ path: "browser.tabs", input: {} });
    expect(await tabs()).toEqual([]);
    identity.path = "/devtools/browser/inventory";
    expect(await tabs()).toEqual([
      { id: tab.id, url: tab.url, title: tab.title },
    ]);
  },
);

browserTest(
  "reports a timed-out inventory read instead of claiming there are no tabs",
  async ({ createServer, chrome, http }) => {
    await fs.mkdir(chrome.profileDir, { recursive: true });
    await fs.writeFile(
      path.join(chrome.profileDir, "DevToolsActivePort"),
      `${new URL(http.url("/")).port}\n/devtools/browser/inventory\n`,
    );
    const server = createServer({ chrome: chrome.config });
    await server.start();
    const tabs = async () =>
      await server.rpc.testApi.invokeTool({ path: "browser.tabs", input: {} });
    const failed = expect(tabs()).rejects.toThrow(/list tabs/);
    (await http.request("/json/version")).respond(
      JSON.stringify({
        webSocketDebuggerUrl: http
          .url("/devtools/browser/inventory")
          .replace("http:", "ws:"),
      }),
      { contentType: "application/json" },
    );
    // The endpoint accepts the request but does not answer before the timeout.
    await http.request("/json/list");
    await failed;

    const retry = tabs();
    (await http.request("/json/version")).respond(
      JSON.stringify({
        webSocketDebuggerUrl: http
          .url("/devtools/browser/inventory")
          .replace("http:", "ws:"),
      }),
      { contentType: "application/json" },
    );
    (await http.request("/json/list")).respond("[]", {
      contentType: "application/json",
    });
    expect(await retry).toEqual([]);
    await fs.rm(path.join(chrome.profileDir, "DevToolsActivePort"));
    expect(await tabs()).toEqual([]);
  },
);
