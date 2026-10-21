import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Dialog,
  type Locator,
  type Page,
} from "playwright";
import * as errore from "errore";

// Playwright actions and navigations; agents may pass a shorter timeout.
const actionTimeout = 30_000;
// Whole browser.call, including methods without a Playwright timeout.
const callBudget = 60_000;
const resultLimit = 256 * 1024;
const launchTimeout = 20_000;

export type ChromeConfig = {
  // Chrome's --user-data-dir; Chrome writes DevToolsActivePort here.
  profileDir: string;
  // Starts the workspace Chrome with --remote-debugging-port=0 on that profile.
  launcher: string;
};

export class BrowserError extends errore.createTaggedError({
  name: "BrowserError",
  message: "Browser operation failed: $detail",
}) {
  constructor(input: { detail: string; cause?: unknown }) {
    super({
      ...input,
      // Tool results expose message, not the cause chain. Preserve Playwright's message.
      detail:
        input.cause instanceof Error
          ? `${input.detail}: ${input.cause.message}`
          : input.detail,
    });
  }
}
export class BrowserUnavailableError extends errore.createTaggedError({
  name: "BrowserUnavailableError",
  message: "The workspace Chrome is not running: $detail",
}) {}
export class BrowserTabNotFoundError extends errore.createTaggedError({
  name: "BrowserTabNotFoundError",
  message:
    "No open tab has ID $pageId. It was closed, or Chrome restarted; list tabs again.",
}) {}
export class BrowserTabNotOwnedError extends errore.createTaggedError({
  name: "BrowserTabNotOwnedError",
  message: "Tab $pageId was not opened by an agent; only agent tabs can close.",
}) {}
export class BrowserStaleRefError extends errore.createTaggedError({
  name: "BrowserStaleRefError",
  message:
    "Ref $ref is from an older snapshot of this tab. Take a new snapshot and use its refs.",
}) {}
export class BrowserOutcomeUnknownError extends errore.createTaggedError({
  name: "BrowserOutcomeUnknownError",
  message:
    "Browser call $method stopped before it finished ($reason). Its effects in the page may still complete; check the page before retrying.",
  extends: errore.AbortError,
}) {}

// Agents pass JSON; markers encode the Playwright arguments JSON cannot carry.
const browserValueSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Null(),
    Type.Array(Self),
    Type.Record(Type.String(), Self),
  ]),
);
type BrowserValue = Static<typeof browserValueSchema>;
export const browserArgsSchema = Type.Array(browserValueSchema);
export const browserStepSchema = Type.Tuple([
  Type.String({ minLength: 1 }),
  browserArgsSchema,
]);
const chainSchema = Type.Array(browserStepSchema);
type BrowserStep = Static<typeof browserStepSchema>;
const objectSchema = Type.Record(Type.String(), browserValueSchema);
const undefinedSchema = Type.Object({ $undefined: Type.Literal(true) });
const regexpSchema = Type.Object({
  $regexp: Type.String(),
  flags: Type.Optional(Type.String()),
});
const functionSchema = Type.Object({ $function: Type.String() });
const locatorSchema = Type.Object({
  $locator: Type.Object({ page: Type.String(), chain: chainSchema }),
});
const ariaRefSchema = Type.String({ pattern: "^aria-ref=" });
const aiModeSchema = Type.Object({ mode: Type.Literal("ai") });
const timeoutSchema = Type.Number({ exclusiveMinimum: 0 });
const pathSchema = Type.String();
type Receiver = Page | Locator;
// A decoded argument as Playwright receives it.
type PlaywrightArg =
  | BrowserValue
  | undefined
  | RegExp
  | Receiver
  | (() => void)
  | AbortSignal
  | PlaywrightArg[]
  | { [key: string]: PlaywrightArg };

const pageBuilders = new Set([
  "locator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByAltText",
  "getByTitle",
  "getByTestId",
]);
const locatorBuilders = new Set([
  ...pageBuilders,
  "filter",
  "first",
  "last",
  "nth",
  "and",
  "or",
]);

type Method = {
  // Index of the options argument that receives timeout and signal.
  optionsAt?: number;
  // Navigation returns a Response, which is not JSON.
  navigation?: true;
  // Option defaults the agent's own options override.
  defaults?: typeof historyDefaults;
};
// Chrome restores history entries from its back-forward cache without a load
// event, so waiting for load times out. Playwright-launched Chromium disables that cache.
const historyDefaults = { waitUntil: "commit" } as const;
const locatorMethods = new Map<string, Method>(
  Object.entries({
    click: { optionsAt: 0 },
    dblclick: { optionsAt: 0 },
    fill: { optionsAt: 1 },
    press: { optionsAt: 1 },
    pressSequentially: { optionsAt: 1 },
    check: { optionsAt: 0 },
    uncheck: { optionsAt: 0 },
    setChecked: { optionsAt: 1 },
    selectOption: { optionsAt: 1 },
    hover: { optionsAt: 0 },
    focus: { optionsAt: 0 },
    clear: { optionsAt: 0 },
    setInputFiles: { optionsAt: 1 },
    scrollIntoViewIfNeeded: { optionsAt: 0 },
    waitFor: { optionsAt: 0 },
    textContent: { optionsAt: 0 },
    innerText: { optionsAt: 0 },
    inputValue: { optionsAt: 0 },
    getAttribute: { optionsAt: 1 },
    isVisible: {},
    isHidden: {},
    isEnabled: { optionsAt: 0 },
    isChecked: { optionsAt: 0 },
    count: {},
    allInnerTexts: {},
    allTextContents: {},
    boundingBox: { optionsAt: 0 },
    ariaSnapshot: { optionsAt: 0 },
    evaluate: { optionsAt: 2 },
  }),
);
const pageMethods = new Map<string, Method>(
  Object.entries({
    goto: { optionsAt: 1, navigation: true },
    reload: { optionsAt: 0, navigation: true },
    goBack: { optionsAt: 0, navigation: true, defaults: historyDefaults },
    goForward: { optionsAt: 0, navigation: true, defaults: historyDefaults },
    title: {},
    content: {},
    evaluate: {},
    waitForURL: { optionsAt: 1 },
    waitForLoadState: { optionsAt: 1 },
    waitForTimeout: {},
    bringToFront: {},
    "keyboard.press": {},
    "keyboard.type": {},
    snapshot: { optionsAt: 0 },
    screenshot: { optionsAt: 0 },
  }),
);

type Connection = { browser: Browser; endpoint: string };
type Owned = { endpoint: string; isolated?: BrowserContext };

/** Drives the workspace's headed Chrome through one CDP connection. Stores tab IDs, not Playwright objects. */
export class BrowserService {
  // The live CDP connection; cleared when Chrome or the socket goes away.
  private connection: Connection | undefined;
  // Single-flight connect or launch attempt.
  private connecting: Promise<Connection | Error> | undefined;
  // Tabs agents opened, keyed by CDP target ID, scoped to one Chrome endpoint.
  private readonly owned = new Map<string, Owned>();
  // Latest AI snapshot generation per tab; refs from older generations are stale.
  private readonly snapshotGenerations = new Map<string, number>();
  private generation = 0;
  private readonly targetIds = new WeakMap<Page, string>();
  private readonly prepared = new WeakSet<Page>();
  private closed = false;
  private readonly chrome: ChromeConfig;
  private readonly workspaceRoot: string;
  private readonly headersFor: (
    origin: string,
  ) => Record<string, string> | undefined;

  constructor(ctx: {
    chrome: ChromeConfig;
    workspaceRoot: string;
    headersFor?: (origin: string) => Record<string, string> | undefined;
  }) {
    const { chrome, workspaceRoot, headersFor = () => undefined } = ctx;
    this.chrome = chrome;
    this.workspaceRoot = workspaceRoot;
    this.headersFor = headersFor;
  }

  async tabs() {
    const connection = await this.connect({ launch: false });
    if (connection instanceof BrowserUnavailableError) return [];
    if (connection instanceof Error) return connection;
    const tabs = await Promise.all(
      this.pages(connection).map(async (page) => {
        const pageId = await this.targetId(page);
        if (pageId instanceof Error) {
          // A tab can close while the list is read.
          console.warn(pageId);
          return undefined;
        }
        return {
          id: pageId,
          url: page.url(),
          title: await titleOf(page),
          owned: this.isOwned(pageId),
        };
      }),
    );
    return tabs.filter((tab) => tab !== undefined);
  }

  async newPage(input: {
    url?: string;
    isolated?: boolean;
    signal?: AbortSignal;
  }) {
    const connection = await this.connect({ launch: true });
    if (connection instanceof Error) return connection;
    await using cleanup = new errore.AsyncDisposableStack();
    const context = input.isolated
      ? await connection.browser
          .newContext()
          .catch(
            (cause) =>
              new BrowserError({ detail: "open isolated context", cause }),
          )
      : connection.browser.contexts()[0];
    if (context instanceof Error) return context;
    if (context === undefined)
      return new BrowserError({ detail: "Chrome has no default context" });
    if (input.isolated) {
      this.watchDialogs(context);
      cleanup.defer(async () => await context.close());
    }
    const page = await context
      .newPage()
      .catch((cause) => new BrowserError({ detail: "open tab", cause }));
    if (page instanceof Error) return page;
    cleanup.defer(async () => await page.close());
    const pageId = await this.targetId(page);
    if (pageId instanceof Error) return pageId;
    this.owned.set(pageId, {
      endpoint: connection.endpoint,
      isolated: input.isolated ? context : undefined,
    });
    cleanup.defer(() => {
      this.owned.delete(pageId);
    });
    const prepared = await this.prepare(page, pageId);
    if (prepared instanceof Error) return prepared;
    if (input.url !== undefined) {
      const url = input.url;
      const loaded = await this.bounded({
        method: "newPage",
        signal: input.signal,
        run: async (signal) =>
          await page
            .goto(url, { timeout: actionTimeout, signal })
            .catch((cause) => new BrowserError({ detail: "goto", cause })),
      });
      if (loaded instanceof Error) return loaded;
    }
    page.once("close", async () => await this.release(pageId));
    cleanup.move();
    return { id: pageId, url: page.url(), title: await titleOf(page) };
  }

  async call(input: {
    page: string;
    chain: BrowserStep[];
    method: string;
    args: BrowserValue[];
    signal?: AbortSignal;
  }) {
    const page = await this.pageFor(input.page);
    if (page instanceof Error) return page;
    const invalid = this.validate(input);
    if (invalid instanceof Error) return invalid;
    const target = this.replay(page, input.page, input.chain);
    const args = this.decode(page, input.page, input.args);
    if (args instanceof Error) return args;
    const outcome = await this.bounded({
      method: input.method,
      signal: input.signal,
      run: async (signal) =>
        await this.invoke({
          page,
          pageId: input.page,
          target,
          method: input.method,
          args,
          signal,
        }),
    });
    if (outcome instanceof Error) return outcome;
    const value = toJson(input.method, outcome.value);
    if (value instanceof Error) return value;
    return { value: value.json, url: page.url() };
  }

  async close(input: { page: string }) {
    const page = await this.pageFor(input.page);
    if (page instanceof Error) return page;
    if (!this.isOwned(input.page))
      return new BrowserTabNotOwnedError({ pageId: input.page });
    const closed = await page
      .close()
      .catch((cause) => new BrowserError({ detail: "close tab", cause }));
    if (closed instanceof Error) return closed;
    await this.release(input.page);
  }

  async shutdown() {
    this.closed = true;
    const pending = await this.connecting;
    const connection =
      this.connection ?? (pending instanceof Error ? undefined : pending);
    this.connection = undefined;
    // Disconnects; the user's Chrome and its default-profile tabs keep running.
    const closed = await connection?.browser
      .close()
      .catch((cause) => new BrowserError({ detail: "disconnect", cause }));
    if (closed instanceof Error) console.warn(closed);
  }

  private async connect(input: { launch: boolean }) {
    if (this.closed)
      return new BrowserError({ detail: "the browser service is shut down" });
    if (this.connection !== undefined) return this.connection;
    const attached = await this.single(async () => await this.attach());
    if (!(attached instanceof BrowserUnavailableError) || !input.launch)
      return attached;
    return await this.single(async () => await this.launch());
  }

  private async single(attempt: () => Promise<Connection | Error>) {
    if (this.connecting !== undefined) return await this.connecting;
    const pending = attempt();
    this.connecting = pending;
    const result = await pending;
    this.connecting = undefined;
    return result;
  }

  private async attach() {
    if (this.connection !== undefined) return this.connection;
    const file = await fs
      .readFile(path.join(this.chrome.profileDir, "DevToolsActivePort"), "utf8")
      .catch(
        (cause) =>
          new BrowserUnavailableError({
            detail: "no DevToolsActivePort",
            cause,
          }),
      );
    if (file instanceof Error) return file;
    const [port, browserPath] = file.trim().split("\n");
    if (!port || !browserPath)
      return new BrowserUnavailableError({
        detail: "DevToolsActivePort is incomplete",
      });
    // Connect to the exact browser endpoint, not a port another process may now hold.
    const endpoint = `ws://127.0.0.1:${port}${browserPath}`;
    const browser = await chromium
      .connectOverCDP(endpoint, { timeout: 5_000 })
      .catch(
        (cause) =>
          new BrowserUnavailableError({ detail: "connect to DevTools", cause }),
      );
    if (browser instanceof Error) return browser;
    if (this.closed) {
      await browser.close();
      return new BrowserError({ detail: "the browser service is shut down" });
    }
    const connection = { browser, endpoint };
    browser.once("disconnected", () => {
      if (this.connection !== connection) return;
      this.connection = undefined;
      // Refs live in this connection's utility world; isolated contexts close with it.
      this.snapshotGenerations.clear();
      for (const [pageId, owned] of this.owned)
        if (owned.isolated !== undefined) this.owned.delete(pageId);
    });
    for (const context of browser.contexts()) this.watchDialogs(context);
    this.connection = connection;
    return connection;
  }

  private async launch() {
    let failure: BrowserUnavailableError | undefined;
    const child = errore.try({
      try: () =>
        spawn(this.chrome.launcher, [], { detached: true, stdio: "ignore" }),
      catch: (cause) =>
        new BrowserUnavailableError({ detail: "start Chrome", cause }),
    });
    if (child instanceof Error) return child;
    child.once("error", (cause) => {
      failure = new BrowserUnavailableError({
        detail: "start Chrome",
        cause,
      });
    });
    // Chrome is the user's application; it keeps running after the server stops.
    child.unref();
    const deadline = Date.now() + launchTimeout;
    for (;;) {
      await sleep(250);
      if (failure !== undefined) return failure;
      const attached = await this.attach();
      if (!(attached instanceof BrowserUnavailableError)) return attached;
      if (Date.now() >= deadline) return attached;
    }
  }

  private pages(connection: Connection) {
    return connection.browser.contexts().flatMap((context) => context.pages());
  }

  private async pageFor(pageId: string) {
    const connection = await this.connect({ launch: false });
    if (connection instanceof Error) return connection;
    for (const page of this.pages(connection)) {
      const candidate = await this.targetId(page);
      if (candidate instanceof Error) {
        console.warn(candidate);
        continue;
      }
      if (candidate !== pageId) continue;
      const prepared = await this.prepare(page, pageId);
      if (prepared instanceof Error) return prepared;
      return page;
    }
    return new BrowserTabNotFoundError({ pageId });
  }

  private async targetId(page: Page) {
    const cached = this.targetIds.get(page);
    if (cached !== undefined) return cached;
    const session = await page
      .context()
      .newCDPSession(page)
      .catch((cause) => new BrowserError({ detail: "attach to tab", cause }));
    if (session instanceof Error) return session;
    const info = await session
      .send("Target.getTargetInfo")
      .catch((cause) => new BrowserError({ detail: "read tab ID", cause }));
    const detached = await session
      .detach()
      .catch((cause) => new BrowserError({ detail: "detach from tab", cause }));
    if (detached instanceof Error) console.warn(detached);
    if (info instanceof Error) return info;
    this.targetIds.set(page, info.targetInfo.targetId);
    return info.targetInfo.targetId;
  }

  private isOwned(pageId: string) {
    const owned = this.owned.get(pageId);
    return owned !== undefined && owned.endpoint === this.connection?.endpoint;
  }

  // Each Playwright connection gets fresh Page objects; reinstall owner routing on them.
  private async prepare(page: Page, pageId: string) {
    if (this.prepared.has(page)) return;
    this.prepared.add(page);
    if (!this.isOwned(pageId)) return;
    // Hosted extensions accept only authenticated requests; agent tabs act as
    // the workspace owner on their direct URLs. The user's tabs are never routed.
    return await page
      .route("**/*", async (route) => {
        const headers = this.headersFor(new URL(route.request().url()).origin);
        await (headers === undefined
          ? route.continue()
          : route.continue({
              headers: { ...route.request().headers(), ...headers },
            }));
      })
      .catch((cause) => new BrowserError({ detail: "route requests", cause }));
  }

  // Playwright dismisses dialogs that have no listener, including the user's.
  private watchDialogs(context: BrowserContext) {
    context.on("dialog", async (dialog: Dialog) => {
      const page = dialog.page();
      const pageId = page === null ? undefined : this.targetIds.get(page);
      if (pageId === undefined || !this.isOwned(pageId)) return;
      const dismissed = await dialog
        .dismiss()
        .catch(
          (cause) => new BrowserError({ detail: "dismiss dialog", cause }),
        );
      if (dismissed instanceof Error) console.warn(dismissed);
    });
  }

  private async release(pageId: string) {
    const owned = this.owned.get(pageId);
    this.owned.delete(pageId);
    this.snapshotGenerations.delete(pageId);
    const context = owned?.isolated;
    if (context === undefined || context.pages().length > 0) return;
    const closed = await context
      .close()
      .catch(
        (cause) =>
          new BrowserError({ detail: "close isolated context", cause }),
      );
    if (closed instanceof Error) console.warn(closed);
  }

  private validate(input: {
    page: string;
    chain: BrowserStep[];
    method: string;
    args: BrowserValue[];
  }) {
    const methods = input.chain.length === 0 ? pageMethods : locatorMethods;
    if (!methods.has(input.method))
      return new BrowserError({
        detail: `${input.chain.length === 0 ? "pages" : "locators"} do not support ${input.method}`,
      });
    return this.validateChain(input.page, input.chain, input.args);
  }

  private validateChain(
    pageId: string,
    chain: BrowserStep[],
    args: BrowserValue[],
  ): BrowserError | BrowserStaleRefError | undefined {
    for (const [index, [name, stepArgs]] of chain.entries()) {
      const builders = index === 0 ? pageBuilders : locatorBuilders;
      if (!builders.has(name))
        return new BrowserError({
          detail: `${index === 0 ? "pages" : "locators"} do not support ${name}`,
        });
      const ref = this.ariaRef(pageId, name, stepArgs);
      if (ref instanceof Error) return ref;
      const nested = this.validateNested(pageId, stepArgs);
      if (nested instanceof Error) return nested;
    }
    return this.validateNested(pageId, args);
  }

  private validateNested(
    pageId: string,
    value: BrowserValue,
  ): BrowserError | BrowserStaleRefError | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const invalid = this.validateNested(pageId, item);
        if (invalid instanceof Error) return invalid;
      }
      return;
    }
    if (!Value.Check(objectSchema, value)) return;
    if ("$locator" in value) {
      if (!Value.Check(locatorSchema, value))
        return new BrowserError({ detail: "malformed $locator argument" });
      if (value.$locator.page !== pageId)
        return new BrowserError({
          detail: "a locator from another tab cannot be used on this tab",
        });
      return this.validateChain(pageId, value.$locator.chain, []);
    }
    for (const item of Object.values(value)) {
      const invalid = this.validateNested(pageId, item);
      if (invalid instanceof Error) return invalid;
    }
  }

  // Snapshot refs are rewritten as s<generation><ref> so stale refs fail fast.
  private ariaRef(pageId: string, name: string, args: BrowserValue[]) {
    const [selector] = args;
    if (name !== "locator" || !Value.Check(ariaRefSchema, selector)) return;
    const ref = selector.slice("aria-ref=".length);
    const match = /^s(\d+)(\S+)$/.exec(ref);
    if (
      match === null ||
      Number(match[1]) !== this.snapshotGenerations.get(pageId)
    )
      return new BrowserStaleRefError({ ref });
    return `aria-ref=${match[2]}`;
  }

  // Inputs are validated; builders only record selectors and do not touch the page.
  private replay(page: Page, pageId: string, chain: BrowserStep[]) {
    return chain.reduce<Receiver>((target, [name, stepArgs]) => {
      const translated = this.ariaRef(pageId, name, stepArgs);
      const args =
        translated === undefined || translated instanceof Error
          ? this.decode(page, pageId, stepArgs)
          : [translated, ...stepArgs.slice(1)];
      // Page and Locator have no index signature for a lookup by validated name.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: validateChain allowed only Playwright builder names for this receiver.
      const builder = (target as unknown as Record<string, Builder>)[name]!;
      return builder.apply(target, args);
    }, page);
  }

  private decode(page: Page, pageId: string, args: BrowserValue[]) {
    return args.map((arg) => this.decodeValue(page, pageId, arg));
  }

  private decodeValue(
    page: Page,
    pageId: string,
    value: BrowserValue,
  ): PlaywrightArg {
    if (Array.isArray(value))
      return value.map((item) => this.decodeValue(page, pageId, item));
    if (!Value.Check(objectSchema, value)) return value;
    if (Value.Check(undefinedSchema, value)) return undefined;
    if (Value.Check(regexpSchema, value))
      return new RegExp(value.$regexp, value.flags);
    if (Value.Check(functionSchema, value)) {
      const source = value.$function;
      // Playwright sends a function's source to the page; this source never runs in Node.
      return Object.assign(function pageFunction() {}, {
        toString: () => source,
      });
    }
    // validateNested checked the nested chain's page and refs.
    if (Value.Check(locatorSchema, value))
      return this.replay(page, pageId, value.$locator.chain);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        this.decodeValue(page, pageId, item),
      ]),
    );
  }

  private async bounded<T>(input: {
    method: string;
    signal: AbortSignal | undefined;
    run: (signal: AbortSignal) => Promise<T>;
  }) {
    const budget = AbortSignal.any([
      ...(input.signal === undefined ? [] : [input.signal]),
      AbortSignal.timeout(callBudget),
    ]);
    const stopped = new Promise<BrowserOutcomeUnknownError>((resolve) => {
      const stop = () =>
        resolve(
          new BrowserOutcomeUnknownError({
            method: input.method,
            reason: input.signal?.aborted
              ? "the exec evaluation was cancelled"
              : `it exceeded ${callBudget / 1_000} seconds`,
            cause: budget.reason,
          }),
        );
      if (budget.aborted) stop();
      else budget.addEventListener("abort", stop, { once: true });
    });
    return await Promise.race([input.run(budget), stopped]);
  }

  private async invoke(input: {
    page: Page;
    pageId: string;
    target: Receiver;
    method: string;
    args: PlaywrightArg[];
    signal: AbortSignal;
  }) {
    const { page, pageId, target, method, signal } = input;
    const methods = target === page ? pageMethods : locatorMethods;
    // validate() checked method against this receiver's table.
    const spec = methods.get(method)!;
    const args = withLimits({
      args: input.args,
      optionsAt: spec.optionsAt,
      defaults: spec.defaults,
      signal,
    });
    const fail = (cause: unknown) =>
      new BrowserError({ detail: method, cause });
    if (
      method === "snapshot" ||
      (method === "ariaSnapshot" && isAiMode(args[0]))
    ) {
      // SAFETY: withLimits put an options object at index 0, snapshot and ariaSnapshot's optionsAt.
      const options = { ...(args[0] as object), mode: "ai" as const };
      const snapshot = await target.ariaSnapshot(options).catch(fail);
      if (snapshot instanceof Error) return snapshot;
      const generation = ++this.generation;
      this.snapshotGenerations.set(pageId, generation);
      return {
        value: snapshot.replaceAll(
          /\[ref=([^\]\s]+)\]/g,
          (_, ref: string) => `[ref=s${generation}${ref}]`,
        ),
      };
    }
    if (method === "screenshot") {
      const directory = path.join(".halo", "browser", "screenshots");
      const relativePath = path.join(directory, `${crypto.randomUUID()}.png`);
      const made = await fs
        .mkdir(path.join(this.workspaceRoot, directory), { recursive: true })
        .catch(fail);
      if (made instanceof Error) return made;
      const saved = await page
        .screenshot({
          // SAFETY: withLimits put an options object at index 0, screenshot's optionsAt.
          ...(args[0] as object),
          type: "png",
          path: path.join(this.workspaceRoot, relativePath),
        })
        .catch(fail);
      if (saved instanceof Error) return saved;
      return { value: { path: relativePath } };
    }
    if (method === "setInputFiles") {
      const files = this.workspaceFiles(args[0]);
      if (files instanceof Error) return files;
      args[0] = files;
    }
    const receiver = method.startsWith("keyboard.") ? page.keyboard : target;
    const name = method.startsWith("keyboard.")
      ? method.slice("keyboard.".length)
      : method;
    // Page, Locator, and Keyboard have no index signature for a lookup by validated name.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: method is an allowlisted Playwright method on this receiver.
    const run = (receiver as unknown as Record<string, Action>)[name]!;
    const value = await run.apply(receiver, args).catch(fail);
    if (value instanceof Error) return value;
    if (spec.navigation !== true) return { value };
    // SAFETY: Playwright navigation methods resolve to Response | null.
    const response = value as Awaited<ReturnType<Page["goto"]>>;
    return {
      value:
        response === null
          ? undefined
          : { url: response.url(), status: response.status() },
    };
  }

  private workspaceFiles(files: PlaywrightArg) {
    const list = Array.isArray(files) ? files : [files];
    const resolved: string[] = [];
    for (const file of list) {
      if (!Value.Check(pathSchema, file))
        return new BrowserError({
          detail: "setInputFiles accepts workspace-relative paths only",
        });
      const absolute = path.resolve(this.workspaceRoot, file);
      const relative = path.relative(this.workspaceRoot, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return new BrowserError({
          detail: `${file} is outside the workspace`,
        });
      resolved.push(absolute);
    }
    return resolved;
  }
}

type Builder = (...args: PlaywrightArg[]) => Receiver;
// oxlint-disable-next-line anti-slop/no-unknown-returns -- Playwright methods resolve to arbitrary page values; toJson checks them.
type Action = (...args: PlaywrightArg[]) => Promise<unknown>;

// A tab blocked by a dialog never answers title(); a missing title is not a failure.
async function titleOf(page: Page) {
  return await Promise.race([page.title().catch(() => ""), sleep(2_000, "")]);
}

function isAiMode(options: PlaywrightArg) {
  return Value.Check(aiModeSchema, options);
}

// Every bounded Playwright call gets the call's signal and at most actionTimeout.
function withLimits(input: {
  args: PlaywrightArg[];
  optionsAt: number | undefined;
  defaults: Method["defaults"];
  signal: AbortSignal;
}) {
  const { args, optionsAt, signal } = input;
  if (optionsAt === undefined) return [...args];
  const given = args[optionsAt];
  const own = Value.Check(objectSchema, given) ? given : undefined;
  const requested = own?.timeout;
  const timeout = Value.Check(timeoutSchema, requested)
    ? Math.min(requested, actionTimeout)
    : actionTimeout;
  const limited: PlaywrightArg[] = Array.from(
    { length: Math.max(args.length, optionsAt + 1) },
    (_, index) => args[index],
  );
  limited[optionsAt] = { ...input.defaults, ...own, timeout, signal };
  return limited;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Playwright results are arbitrary page values; this boundary checks they are JSON.
function toJson(method: string, value: unknown) {
  const text = errore.try({
    try: () => JSON.stringify(value),
    catch: (cause) =>
      new BrowserError({
        detail: `${method} returned a non-JSON value`,
        cause,
      }),
  });
  if (text instanceof Error) return text;
  if (text !== undefined && text.length > resultLimit)
    return new BrowserError({
      detail: `${method} returned ${text.length} bytes; the limit is ${resultLimit}. Return less data.`,
    });
  return {
    // SAFETY: text came from JSON.stringify.
    json: text === undefined ? undefined : (JSON.parse(text) as BrowserValue),
  };
}
