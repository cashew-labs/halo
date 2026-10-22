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
import { SerialQueue } from "@get-halo/shared/SerialQueue";

// Playwright actions and navigations; agents may pass a shorter timeout.
const actionTimeout = 30_000;
// Whole browser call, from finding the tab to the result.
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
export class BrowserStaleRefError extends errore.createTaggedError({
  name: "BrowserStaleRefError",
  message:
    "Ref $ref is not from the latest snapshot of this tab. Take a new snapshot and use its refs.",
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
type BrowserStep = Static<typeof browserStepSchema>;
const objectSchema = Type.Record(Type.String(), browserValueSchema);
const scalarSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);
const strict = { additionalProperties: false } as const;
const undefinedSchema = Type.Object({ $undefined: Type.Literal(true) }, strict);
const regexpSchema = Type.Object(
  { $regexp: Type.String(), flags: Type.Optional(Type.String()) },
  strict,
);
const functionSchema = Type.Object({ $function: Type.String() }, strict);
// A locator argument is a non-empty chain; an empty one would be the page itself.
const locatorSchema = Type.Object(
  {
    $locator: Type.Object(
      {
        page: Type.String(),
        chain: Type.Array(browserStepSchema, { minItems: 1 }),
      },
      strict,
    ),
  },
  strict,
);
const selectorSchema = Type.String();
const aiModeSchema = Type.Object({ mode: Type.Literal("ai") });
const timeoutSchema = Type.Number({ exclusiveMinimum: 0 });
const pathSchema = Type.String();
// The only accepted form of a snapshot ref: aria-ref=s<generation><Playwright ref>.
const refPattern = /^aria-ref=s(\d+)([a-z]\S*)$/;
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
  // The only options agents may pass, when the method has dangerous ones.
  optionKeys?: readonly string[];
  // Most arguments the method accepts; defaults to optionsAt + 1.
  maxArgs?: number;
  // Navigation returns a Response, which is not JSON.
  navigation?: true;
  // Option defaults the agent's own options override.
  defaults?: typeof historyDefaults;
  // Accepts $locator arguments, as screenshot's mask does.
  locators?: true;
  // Accepts a $function as its first argument.
  pageFunction?: true;
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
    // exposeFunctions would hand Playwright's own objects to page code.
    evaluate: { optionsAt: 2, optionKeys: ["timeout"], pageFunction: true },
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
    evaluate: { maxArgs: 2, pageFunction: true },
    waitForURL: { optionsAt: 1 },
    waitForLoadState: { optionsAt: 1 },
    waitForTimeout: {},
    bringToFront: {},
    "keyboard.press": {},
    "keyboard.type": {},
    snapshot: { optionsAt: 0 },
    screenshot: { optionsAt: 0, locators: true },
  }),
);

type Connection = { browser: Browser; endpoint: string };

/** Drives the workspace's headed Chrome through one CDP connection. Stores tab IDs, not Playwright objects. */
export class BrowserService {
  // The live CDP connection; cleared when Chrome or the socket goes away.
  private connection: Connection | undefined;
  // Single-flight connect or launch attempt.
  private connecting: Promise<Connection | Error> | undefined;
  // Latest snapshot generation per tab; refs from other generations are stale.
  private readonly snapshotGenerations = new Map<string, number>();
  // Snapshots of one tab run in order, so generations match Playwright's ref cache.
  private readonly snapshotQueues = new Map<string, SerialQueue>();
  // Random start, so refs issued before a server restart do not match new ones.
  private generation = crypto.randomInt(1, 1_000_000);
  private readonly targetIds = new WeakMap<Page, string>();
  // Agent calls running on each tab; dialogs on these tabs are dismissed.
  private readonly busy = new Map<Page, number>();
  // A dialog that opened while no agent call ran; the next call dismisses it.
  private readonly pendingDialogs = new WeakMap<Page, Dialog>();
  private closed = false;
  private readonly chrome: ChromeConfig;
  private readonly workspaceRoot: string;

  constructor(ctx: { chrome: ChromeConfig; workspaceRoot: string }) {
    this.chrome = ctx.chrome;
    this.workspaceRoot = ctx.workspaceRoot;
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
        return { id: pageId, url: page.url(), title: await titleOf(page) };
      }),
    );
    return tabs.filter((tab) => tab !== undefined);
  }

  async newPage(input: {
    url?: string;
    isolated?: boolean;
    signal?: AbortSignal;
  }) {
    return await this.bounded({
      method: "newPage",
      signal: input.signal,
      run: async (signal) => {
        const connection = await this.connect({ launch: true });
        if (connection instanceof Error) return connection;
        if (signal.aborted) return cancelled();
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
          this.closeWhenEmpty(context);
          cleanup.defer(async () => await context.close());
        }
        const page = await context
          .newPage()
          .catch((cause) => new BrowserError({ detail: "open tab", cause }));
        if (page instanceof Error) return page;
        cleanup.defer(async () => await page.close());
        const pageId = await this.targetId(page);
        if (pageId instanceof Error) return pageId;
        if (input.url !== undefined) {
          const url = input.url;
          const loaded = await this.track(
            page,
            async () =>
              await page
                .goto(url, { timeout: actionTimeout, signal })
                .catch((cause) => new BrowserError({ detail: "goto", cause })),
          );
          if (loaded instanceof Error) return loaded;
        }
        // The caller already received an error; do not leave an unknown tab behind.
        if (signal.aborted) return cancelled();
        cleanup.move();
        return { id: pageId, url: page.url(), title: await titleOf(page) };
      },
    });
  }

  async call(input: {
    page: string;
    chain: BrowserStep[];
    method: string;
    args: BrowserValue[];
    signal?: AbortSignal;
  }) {
    const spec = this.validate(input);
    if (spec instanceof Error) return spec;
    const limited = limitOptions(input.args, spec);
    if (limited instanceof Error) return limited;
    return await this.bounded({
      method: input.method,
      signal: input.signal,
      run: async (signal) => {
        const page = await this.pageFor(input.page);
        if (page instanceof Error) return page;
        const target = this.replay(page, input.page, input.chain);
        if (target instanceof Error) return target;
        const args = this.decodeArgs(page, input.page, limited);
        if (args instanceof Error) return args;
        if (spec.optionsAt !== undefined)
          args[spec.optionsAt] = {
            // SAFETY: limitOptions put a plain options object here, and decoding keeps plain objects.
            ...(args[spec.optionsAt] as Record<string, PlaywrightArg>),
            signal,
          };
        // Nothing has touched the page yet; stop here if the call was cancelled.
        if (signal.aborted) return cancelled();
        const outcome = await this.track(
          page,
          async () =>
            await this.invoke({
              page,
              pageId: input.page,
              target,
              method: input.method,
              spec,
              args,
            }),
        );
        if (outcome instanceof Error) return outcome;
        const value = toJson(input.method, outcome.value);
        if (value instanceof Error) return value;
        return { value: value.json, url: page.url() };
      },
    });
  }

  async close(input: { page: string }) {
    const page = await this.pageFor(input.page);
    if (page instanceof Error) return page;
    const closed = await page
      .close()
      .catch((cause) => new BrowserError({ detail: "close tab", cause }));
    if (closed instanceof Error) return closed;
    this.snapshotGenerations.delete(input.page);
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
      // Refs live in this connection's utility world.
      this.snapshotGenerations.clear();
      this.snapshotQueues.clear();
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
      if (candidate === pageId) return page;
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

  // Playwright dismisses dialogs that have no listener, including the user's.
  // Only dialogs that block an agent call are dismissed.
  private watchDialogs(context: BrowserContext) {
    context.on("dialog", async (dialog: Dialog) => {
      const page = dialog.page();
      if (page === null) return;
      if (this.busy.has(page)) await dismiss(dialog);
      else this.pendingDialogs.set(page, dialog);
    });
  }

  private async track<T>(page: Page, run: () => Promise<T>) {
    this.busy.set(page, (this.busy.get(page) ?? 0) + 1);
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => {
      const count = this.busy.get(page)! - 1;
      if (count === 0) this.busy.delete(page);
      else this.busy.set(page, count);
    });
    const pending = this.pendingDialogs.get(page);
    this.pendingDialogs.delete(page);
    if (pending !== undefined) await dismiss(pending);
    return await run();
  }

  // An isolated context exists for agent tabs; close it with its last page, popups included.
  private closeWhenEmpty(context: BrowserContext) {
    context.on("page", (page) => {
      page.once("close", async () => {
        if (context.pages().length > 0) return;
        if (context.browser()?.isConnected() !== true) return;
        const closed = await context
          .close()
          .catch(
            (cause) =>
              new BrowserError({ detail: "close isolated context", cause }),
          );
        if (closed instanceof Error) console.warn(closed);
      });
    });
  }

  private validate(input: {
    page: string;
    chain: BrowserStep[];
    method: string;
    args: BrowserValue[];
  }) {
    const methods = input.chain.length === 0 ? pageMethods : locatorMethods;
    const spec = methods.get(input.method);
    if (spec === undefined)
      return new BrowserError({
        detail: `${input.chain.length === 0 ? "pages" : "locators"} do not support ${input.method}`,
      });
    const maxArgs =
      spec.maxArgs ??
      (spec.optionsAt === undefined ? undefined : spec.optionsAt + 1);
    if (maxArgs !== undefined && input.args.length > maxArgs)
      return new BrowserError({
        detail: `${input.method} takes at most ${maxArgs} arguments`,
      });
    const chain = this.validateChain(input.page, input.chain);
    if (chain instanceof Error) return chain;
    for (const [index, arg] of input.args.entries()) {
      const invalid = this.validateValue(input.page, arg, {
        locators: spec.locators === true,
        pageFunction: spec.pageFunction === true && index === 0,
      });
      if (invalid instanceof Error) return invalid;
    }
    return spec;
  }

  private validateChain(
    pageId: string,
    chain: BrowserStep[],
  ): BrowserError | BrowserStaleRefError | undefined {
    for (const [index, [name, stepArgs]] of chain.entries()) {
      const builders = index === 0 ? pageBuilders : locatorBuilders;
      if (!builders.has(name))
        return new BrowserError({
          detail: `${index === 0 ? "pages" : "locators"} do not support ${name}`,
        });
      const ref = this.ariaRef(pageId, name, stepArgs);
      if (ref instanceof Error) return ref;
      for (const arg of stepArgs) {
        // Builders such as filter({ has }) take locators; none take functions.
        const invalid = this.validateValue(pageId, arg, {
          locators: true,
          pageFunction: false,
        });
        if (invalid instanceof Error) return invalid;
      }
    }
  }

  // Markers are accepted only where Playwright expects them, so page code never
  // receives a Page or Locator and functions reach only evaluate.
  private validateValue(
    pageId: string,
    value: BrowserValue,
    allow: { locators: boolean; pageFunction: boolean },
  ): BrowserError | BrowserStaleRefError | undefined {
    const nested = { locators: allow.locators, pageFunction: false };
    if (Array.isArray(value)) {
      for (const item of value) {
        const invalid = this.validateValue(pageId, item, nested);
        if (invalid instanceof Error) return invalid;
      }
      return;
    }
    if (!Value.Check(objectSchema, value)) return;
    if ("$locator" in value) {
      if (!allow.locators)
        return new BrowserError({
          detail:
            "$locator is accepted only by locator builders and screenshot's mask",
        });
      if (!Value.Check(locatorSchema, value))
        return new BrowserError({ detail: "malformed $locator argument" });
      if (value.$locator.page !== pageId)
        return new BrowserError({
          detail: "a locator from another tab cannot be used on this tab",
        });
      return this.validateChain(pageId, value.$locator.chain);
    }
    if ("$function" in value) {
      if (!allow.pageFunction || !Value.Check(functionSchema, value))
        return new BrowserError({
          detail: "$function is accepted only as evaluate's first argument",
        });
      return;
    }
    if ("$regexp" in value) {
      if (!Value.Check(regexpSchema, value))
        return new BrowserError({ detail: "malformed $regexp argument" });
      const { $regexp: source, flags } = value;
      const compiled = errore.try({
        try: () => new RegExp(source, flags),
        catch: (cause) =>
          new BrowserError({ detail: "invalid $regexp", cause }),
      });
      if (compiled instanceof Error) return compiled;
      return;
    }
    if ("$undefined" in value) {
      if (!Value.Check(undefinedSchema, value))
        return new BrowserError({ detail: "malformed $undefined argument" });
      return;
    }
    for (const item of Object.values(value)) {
      const invalid = this.validateValue(pageId, item, nested);
      if (invalid instanceof Error) return invalid;
    }
  }

  // Snapshot refs are rewritten as s<generation><ref> so stale refs fail fast.
  // Any other selector naming aria-ref would bypass that check.
  private ariaRef(pageId: string, name: string, args: BrowserValue[]) {
    const [selector] = args;
    if (name !== "locator" || !Value.Check(selectorSchema, selector)) return;
    if (!/aria-ref/i.test(selector)) return;
    const match = refPattern.exec(selector);
    if (match === null)
      return new BrowserError({
        detail: `use a snapshot ref alone, as locator("aria-ref=s1e2"), not ${JSON.stringify(selector)}`,
      });
    if (Number(match[1]) !== this.snapshotGenerations.get(pageId))
      return new BrowserStaleRefError({
        ref: selector.slice("aria-ref=".length),
      });
    return `aria-ref=${match[2]}`;
  }

  // Inputs are validated; builders only record selectors and do not touch the page.
  private replay(
    page: Page,
    pageId: string,
    chain: BrowserStep[],
  ): Receiver | BrowserError {
    let target: Receiver = page;
    for (const [name, stepArgs] of chain) {
      const translated = this.ariaRef(pageId, name, stepArgs);
      const args =
        translated === undefined || translated instanceof Error
          ? this.decodeArgs(page, pageId, stepArgs)
          : [translated, ...stepArgs.slice(1)];
      if (args instanceof Error) return args;
      // Page and Locator have no index signature for a lookup by validated name.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: validateChain allowed only Playwright builder names for this receiver.
      const builder: Builder = (target as unknown as Record<string, Builder>)[
        name
      ]!;
      const receiver: Receiver = target;
      const next: Receiver | BrowserError = errore.try({
        try: (): Receiver => builder.apply(receiver, args),
        catch: (cause) => new BrowserError({ detail: name, cause }),
      });
      if (next instanceof Error) return next;
      target = next;
    }
    return target;
  }

  private decodeArgs(page: Page, pageId: string, args: BrowserValue[]) {
    const decoded: PlaywrightArg[] = [];
    for (const arg of args) {
      const value = this.decodeValue(page, pageId, arg);
      if (value instanceof Error) return value;
      decoded.push(value);
    }
    return decoded;
  }

  private decodeValue(
    page: Page,
    pageId: string,
    value: BrowserValue,
  ): PlaywrightArg | BrowserError {
    if (Array.isArray(value)) return this.decodeArgs(page, pageId, value);
    if (!Value.Check(objectSchema, value)) return value;
    if (Value.Check(undefinedSchema, value)) return undefined;
    // validateValue compiled this pattern.
    if (Value.Check(regexpSchema, value))
      return new RegExp(value.$regexp, value.flags);
    if (Value.Check(functionSchema, value)) {
      const source = value.$function;
      // Playwright sends a function's source to the page; this source never runs in Node.
      return Object.assign(function pageFunction() {}, {
        toString: () => source,
      });
    }
    // validateValue checked the nested chain's page and refs.
    if (Value.Check(locatorSchema, value))
      return this.replay(page, pageId, value.$locator.chain);
    const decoded: Record<string, PlaywrightArg> = {};
    for (const [key, item] of Object.entries(value)) {
      const member = this.decodeValue(page, pageId, item);
      if (member instanceof Error) return member;
      decoded[key] = member;
    }
    return decoded;
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
    const stopped = () =>
      new BrowserOutcomeUnknownError({
        method: input.method,
        reason: input.signal?.aborted
          ? "the exec evaluation was cancelled"
          : `it exceeded ${callBudget / 1_000} seconds`,
        cause: budget.reason,
      });
    if (budget.aborted) return stopped();
    const aborted = new Promise<BrowserOutcomeUnknownError>((resolve) => {
      budget.addEventListener("abort", () => resolve(stopped()), {
        once: true,
      });
    });
    return await Promise.race([input.run(budget), aborted]);
  }

  private async invoke(input: {
    page: Page;
    pageId: string;
    target: Receiver;
    method: string;
    spec: Method;
    args: PlaywrightArg[];
  }) {
    const { page, pageId, target, method, spec, args } = input;
    const fail = (cause: unknown) =>
      new BrowserError({ detail: method, cause });
    if (method === "snapshot" || method === "ariaSnapshot") {
      const ai = method === "snapshot" || Value.Check(aiModeSchema, args[0]);
      // SAFETY: limitOptions put an options object at index 0, snapshot and ariaSnapshot's optionsAt.
      const given = args[0] as Parameters<Locator["ariaSnapshot"]>[0];
      const options = ai ? { ...given, mode: "ai" as const } : given;
      const queue = this.snapshotQueues.get(pageId) ?? new SerialQueue();
      this.snapshotQueues.set(pageId, queue);
      return await queue.run(async () => {
        const snapshot = await target.ariaSnapshot(options).catch(fail);
        if (snapshot instanceof Error) return snapshot;
        // Every snapshot replaces Playwright's refs for its frames, so older refs go stale.
        const generation = ++this.generation;
        this.snapshotGenerations.set(pageId, generation);
        if (!ai) return { value: snapshot };
        return {
          value: snapshot.replaceAll(
            /\[ref=([^\]\s]+)\]/g,
            (_, ref: string) => `[ref=s${generation}${ref}]`,
          ),
        };
      });
    }
    if (method === "screenshot") {
      const directory = await this.workspaceDirectory(
        path.join(".halo", "browser", "screenshots"),
      );
      if (directory instanceof Error) return directory;
      const name = `${crypto.randomUUID()}.png`;
      const saved = await page
        .screenshot({
          // SAFETY: limitOptions put an options object at index 0, screenshot's optionsAt.
          ...(args[0] as object),
          type: "png",
          path: path.join(directory.real, name),
        })
        .catch(fail);
      if (saved instanceof Error) return saved;
      return { value: { path: path.join(directory.relative, name) } };
    }
    if (method === "setInputFiles") {
      const files = await this.workspaceFiles(args[0]);
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

  // Creates a workspace directory and checks that symlinks do not lead out of the workspace.
  private async workspaceDirectory(relative: string) {
    const root = await this.realRoot();
    if (root instanceof Error) return root;
    const made = await fs
      .mkdir(path.join(root, relative), { recursive: true })
      .catch(
        (cause) => new BrowserError({ detail: `create ${relative}`, cause }),
      );
    if (made instanceof Error) return made;
    const real = await fs
      .realpath(path.join(root, relative))
      .catch(
        (cause) => new BrowserError({ detail: `resolve ${relative}`, cause }),
      );
    if (real instanceof Error) return real;
    if (!isInside(root, real))
      return new BrowserError({
        detail: `${relative} leads outside the workspace`,
      });
    return { real, relative };
  }

  private async workspaceFiles(files: PlaywrightArg) {
    const root = await this.realRoot();
    if (root instanceof Error) return root;
    const list = Array.isArray(files) ? files : [files];
    const resolved: string[] = [];
    for (const file of list) {
      if (!Value.Check(pathSchema, file) || path.isAbsolute(file))
        return new BrowserError({
          detail: "setInputFiles accepts workspace-relative file paths only",
        });
      // Resolve symlinks before the containment check; Playwright reads the target.
      const real = await fs
        .realpath(path.join(root, file))
        .catch((cause) => new BrowserError({ detail: `read ${file}`, cause }));
      if (real instanceof Error) return real;
      if (!isInside(root, real))
        return new BrowserError({ detail: `${file} is outside the workspace` });
      const stat = await fs
        .stat(real)
        .catch((cause) => new BrowserError({ detail: `read ${file}`, cause }));
      if (stat instanceof Error) return stat;
      if (!stat.isFile())
        return new BrowserError({ detail: `${file} is not a file` });
      resolved.push(real);
    }
    return resolved;
  }

  private async realRoot() {
    return await fs
      .realpath(this.workspaceRoot)
      .catch(
        (cause) => new BrowserError({ detail: "resolve the workspace", cause }),
      );
  }
}

type Builder = (...args: PlaywrightArg[]) => Receiver;
// oxlint-disable-next-line anti-slop/no-unknown-returns -- Playwright methods resolve to arbitrary page values; toJson checks them.
type Action = (...args: PlaywrightArg[]) => Promise<unknown>;

function cancelled() {
  return new BrowserError({ detail: "the call was cancelled" });
}

async function dismiss(dialog: Dialog) {
  // The user may already have answered it.
  const dismissed = await dialog
    .dismiss()
    .catch((cause) => new BrowserError({ detail: "dismiss dialog", cause }));
  if (dismissed instanceof Error) console.warn(dismissed);
}

// A tab blocked by a dialog never answers title(); a missing title is not a failure.
async function titleOf(page: Page) {
  return await Promise.race([page.title().catch(() => ""), sleep(2_000, "")]);
}

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

// Every bounded Playwright call gets at most actionTimeout. The call's signal is
// added after decoding.
function limitOptions(args: BrowserValue[], spec: Method) {
  const { optionsAt } = spec;
  if (optionsAt === undefined) return args;
  const given = args[optionsAt];
  const own =
    given === undefined || Value.Check(undefinedSchema, given)
      ? {}
      : Value.Check(objectSchema, given)
        ? given
        : undefined;
  if (own === undefined)
    return new BrowserError({
      detail: `argument ${optionsAt + 1} must be an options object`,
    });
  const unsupported = Object.keys(own).filter(
    (key) => spec.optionKeys !== undefined && !spec.optionKeys.includes(key),
  );
  if (unsupported.length > 0)
    return new BrowserError({
      detail: `unsupported options ${unsupported.join(", ")}`,
    });
  const requested = own.timeout;
  const timeout = Value.Check(timeoutSchema, requested)
    ? Math.min(requested, actionTimeout)
    : actionTimeout;
  const limited: BrowserValue[] = Array.from(
    { length: Math.max(args.length, optionsAt + 1) },
    (_, index) => (index < args.length ? args[index]! : { $undefined: true }),
  );
  limited[optionsAt] = { ...spec.defaults, ...own, timeout };
  return limited;
}

// Playwright results are strict JSON: no NaN, dates, regexps, maps, or cycles.
// Undefined object members are dropped, as JSON.stringify does.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Playwright results are arbitrary page values; this boundary checks they are JSON.
function jsonProblem(value: unknown, seen: Set<object>): string | undefined {
  if (Value.Check(scalarSchema, value)) return;
  if (Array.isArray(value) || isPlainObject(value)) {
    if (seen.has(value)) return "a cycle";
    seen.add(value);
    const items = Array.isArray(value)
      ? value
      : Object.values(value).filter((item) => item !== undefined);
    for (const item of items) {
      const problem = jsonProblem(item, seen);
      if (problem !== undefined) return problem;
    }
    seen.delete(value);
    return;
  }
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  return tag === "Number" ? "NaN or Infinity" : tag;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Checks the shape of an arbitrary Playwright result.
function isPlainObject(value: unknown): value is object {
  if (value === null || !(value instanceof Object)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Playwright results are arbitrary page values; this boundary checks they are JSON.
function toJson(method: string, value: unknown) {
  if (value === undefined) return { json: undefined };
  const problem = errore.try({
    try: () => jsonProblem(value, new Set()),
    catch: (cause) => new BrowserError({ detail: `${method} result`, cause }),
  });
  if (problem instanceof Error) return problem;
  if (problem !== undefined)
    return new BrowserError({
      detail: `${method} returned a non-JSON value (${problem}). Return strings, numbers, booleans, null, arrays, and plain objects.`,
    });
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > resultLimit)
    return new BrowserError({
      detail: `${method} returned ${bytes} bytes; the limit is ${resultLimit}. Return less data.`,
    });
  // SAFETY: jsonProblem checked that value is JSON.
  return { json: value as BrowserValue };
}
