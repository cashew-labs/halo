import { parentPort } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import {
  newQuickJSWASMModule,
  type QuickJSDeferredPromise,
} from "quickjs-emscripten";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import * as errore from "errore";
import type { ExecuteResult } from "@executor-js/codemode-core";
import type {
  CodeWorkerRequest,
  CodeWorkerResponse,
} from "./codeWorkerProtocol.js";

// This module only runs in a worker. Guest code never receives Node objects.
class ResultSerializationError extends errore.createTaggedError({
  name: "ResultSerializationError",
  message: "Exec result is not JSON serializable; bindings were retained",
}) {}

const port = parentPort!;
const module = await newQuickJSWASMModule(variant);
const runtime = module.newRuntime();
runtime.setMemoryLimit(32 * 1024 * 1024);
runtime.setMaxStackSize(1024 * 1024);
const vm = runtime.newContext();
const pending = new Map<string, QuickJSDeferredPromise>();
const imageInvocations = new Set<string>();
type Evaluation = {
  id: string;
  logs: string[];
  bytes: number;
  result?: ExecuteResult;
  reset: boolean;
};
let evaluation: Evaluation | undefined;
let deadline = Infinity;
runtime.setInterruptHandler(() => Date.now() >= deadline);

function send(message: CodeWorkerResponse) {
  port.postMessage(message);
}

function finish() {
  if (!evaluation?.result || (!evaluation.reset && pending.size > 0)) return;
  send({
    type: "completed",
    id: evaluation.id,
    result: { ...evaluation.result, logs: evaluation.logs },
    reset: evaluation.reset,
  });
  evaluation = undefined;
}

function pump() {
  deadline = Date.now() + 2_000;
  const jobs = runtime.executePendingJobs();
  if (jobs.error) {
    const error = JSON.stringify(vm.dump(jobs.error));
    jobs.error.dispose();
    if (evaluation) {
      evaluation.result = { result: undefined, error };
      evaluation.reset = true;
    }
  }
  finish();
}

const call = vm.newFunction("__call", (path, args) => {
  if (!evaluation) return { error: vm.newError("No active exec evaluation") };
  if (pending.size >= 128)
    return { error: vm.newError("Too many outstanding tool calls") };
  const invocationId = randomUUID();
  const promise = vm.newPromise();
  pending.set(invocationId, promise);
  if (vm.getString(path) === "__viewImage") imageInvocations.add(invocationId);
  send({
    type: vm.getString(path) === "__viewImage" ? "viewImage" : "toolCall",
    id: evaluation.id,
    invocationId,
    path: vm.getString(path),
    args: vm.dump(args),
  });
  return promise.handle;
});
vm.setProp(vm.global, "__call", call);
call.dispose();
const log = vm.newFunction("__log", (value) => {
  if (!evaluation) return vm.undefined;
  const text = vm.getString(value);
  evaluation.bytes += text.length;
  if (evaluation.bytes > 64 * 1024)
    return { error: vm.newError("Console output limit exceeded") };
  evaluation.logs.push(text);
  return vm.undefined;
});
vm.setProp(vm.global, "__log", log);
log.dispose();
const bootstrap = vm.evalCode(`
(() => {
  const invoke = globalThis.__call;
  const log = globalThis.__log;
  delete globalThis.__call;
  delete globalThis.__log;
  const browser = (() => {
    // A thin Playwright-shaped client: every terminal call is one browser.* tool call.
    const call = async (path, args) => {
      const result = await invoke(path, args);
      if (result && result.ok) return result.data;
      const error = new Error(result?.error?.message ?? 'Browser tool failed');
      error.name = result?.error?.code ?? 'BrowserError';
      throw error;
    };
    const chainOf = Symbol('chain');
    const pageOf = Symbol('page');
    const isPlain = (value) => {
      if (value === null || typeof value !== 'object') return false;
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    };
    const encode = (value) => {
      if (value === undefined) return { $undefined: true };
      if (value instanceof RegExp) return { $regexp: value.source, flags: value.flags };
      if (typeof value === 'function') {
        const source = Function.prototype.toString.call(value);
        if (source.includes('[native code]'))
          throw new TypeError('Pass an arrow or function expression; native and bound functions have no source');
        return { $function: source };
      }
      if (value !== null && typeof value === 'object' && chainOf in value)
        return { $locator: { page: value[pageOf], chain: value[chainOf] } };
      if (Array.isArray(value)) return value.map(encode);
      if (isPlain(value))
        // fromEntries keeps a "__proto__" key as data.
        return Object.fromEntries(
          Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .map(([key, item]) => [key, encode(item)]),
        );
      if (value === null || typeof value !== 'object') return value;
      throw new TypeError('Browser arguments must be JSON values, RegExps, functions, or locators');
    };
    const pageBuilders = ['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId'];
    const locatorBuilders = [...pageBuilders, 'filter', 'first', 'last', 'nth', 'and', 'or'];
    const locatorMethods = ['click', 'dblclick', 'fill', 'press', 'pressSequentially', 'check', 'uncheck', 'setChecked', 'selectOption', 'hover', 'focus', 'clear', 'setInputFiles', 'scrollIntoViewIfNeeded', 'waitFor', 'textContent', 'innerText', 'inputValue', 'getAttribute', 'isVisible', 'isHidden', 'isEnabled', 'isChecked', 'count', 'allInnerTexts', 'allTextContents', 'boundingBox', 'ariaSnapshot', 'evaluate'];
    const pageMethods = ['goto', 'reload', 'goBack', 'goForward', 'title', 'content', 'evaluate', 'waitForURL', 'waitForLoadState', 'waitForTimeout', 'bringToFront', 'snapshot'];
    const builders = (target, run, pageId, chain, names) => {
      for (const name of names)
        target[name] = (...args) => locator(run, pageId, [...chain, [name, args.map(encode)]]);
    };
    const locator = (run, pageId, chain) => {
      const target = { [chainOf]: chain, [pageOf]: pageId };
      for (const name of locatorMethods) target[name] = (...args) => run(chain, name, args);
      builders(target, run, pageId, chain, locatorBuilders);
      return Object.freeze(target);
    };
    const page = (info) => {
      let url = info.url;
      // Sent with every call from this page object; the server keeps no dialog state.
      let dialogs;
      const run = async (chain, method, args) => {
        const data = await call('browser.call', { page: info.id, chain, method, args: args.map(encode), dialogs });
        url = data.url;
        for (const dialog of data.dialogs ?? [])
          log((dialog.accepted ? 'Accepted' : 'Dismissed') + ' browser ' + dialog.type + ' dialog: ' + JSON.stringify(dialog.message) +
            (dialog.accepted ? '' : ". Call page.handleDialogs('accept') before the action to accept dialogs instead."));
        return data.value;
      };
      const target = {
        id: info.id,
        url: () => url,
        handleDialogs: (action, options) => {
          if (action !== 'accept' && action !== 'dismiss') throw new TypeError("handleDialogs takes 'accept' or 'dismiss'");
          dialogs = { action, ...(options?.promptText === undefined ? {} : { promptText: String(options.promptText) }) };
        },
      };
      for (const name of pageMethods) target[name] = (...args) => run([], name, args);
      target.screenshot = async (...args) => {
        const shot = await run([], 'screenshot', args);
        viewImage(shot);
        return shot;
      };
      target.keyboard = Object.freeze({
        press: (...args) => run([], 'keyboard.press', args),
        type: (...args) => run([], 'keyboard.type', args),
      });
      target.close = async () => { await call('browser.close', { page: info.id }); };
      builders(target, run, info.id, [], pageBuilders);
      return Object.freeze(target);
    };
    return Object.freeze({
      newPage: async (options) => page(await call('browser.newPage', encode(options ?? {}))),
      tabs: async () => await call('browser.tabs', {}),
      page: async (id) => {
        const tab = (await call('browser.tabs', {})).find((candidate) => candidate.id === id);
        if (tab === undefined) throw new Error('No open tab has ID ' + id + '; list tabs again');
        return page(tab);
      },
    });
  })();
  const proxy = (path) => new Proxy(function() {}, {
    get(_, key) {
      if (key === 'then' || typeof key === 'symbol') return undefined;
      // tools["browser.call"] is a different key and still reaches the raw tool.
      if (path === '' && key === 'browser') return browser;
      return proxy(path ? path + '.' + key : key);
    },
    apply(_, receiver, args) { return invoke(path, args[0] ?? {}); }
  });
  Object.defineProperty(globalThis, 'tools', { value: proxy('') });
  Object.defineProperty(globalThis, 'viewImage', { value: ref => invoke('__viewImage', ref) });
  Object.defineProperty(globalThis, 'console', { value: Object.freeze(Object.fromEntries(
    ['log','info','warn','error','debug'].map(key => [key, (...args) => log(args.map(
      value => typeof value === 'string' ? value : JSON.stringify(value)
    ).join(' '))])
  )) });
})();
`);
vm.unwrapResult(bootstrap).dispose();

port.on("message", async (message: CodeWorkerRequest) => {
  if (message.type === "toolResult") {
    if (evaluation?.id !== message.id) return;
    const promise = pending.get(message.invocationId);
    if (!promise) return;
    pending.delete(message.invocationId);
    if (imageInvocations.delete(message.invocationId)) {
      if (message.imageError)
        evaluation.logs.push(`viewImage: ${message.imageError}`);
    }
    // Parse as data, never interpolate executable source from a tool result.
    const json = vm.newString(JSON.stringify(message.value) ?? "null");
    deadline = Date.now() + 2_000;
    const parser = vm.getProp(vm.global, "JSON");
    const parse = vm.getProp(parser, "parse");
    const value = vm.callFunction(parse, parser, json);
    json.dispose();
    parse.dispose();
    parser.dispose();
    if (value.error) {
      promise.reject(value.error);
      value.error.dispose();
    } else {
      promise.resolve(value.value);
      value.value.dispose();
    }
    promise.dispose();
    pump();
    return;
  }
  evaluation = { id: message.id, logs: [], bytes: 0, reset: false };
  const current = evaluation;
  deadline = Date.now() + 2_000;
  // JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_ASYNC in pinned QuickJS 0.31.
  // Native declarations persist; completion is Promise<{ value }>.
  const result = vm.evalCode(message.code, "exec.js", 128);
  if (result.error) {
    const error = vm.dump(result.error);
    result.error.dispose();
    current.result = {
      result: undefined,
      error: error?.message ? `${error.name}: ${error.message}` : String(error),
    };
    current.reset = error?.name === "InternalError";
    finish();
    return;
  }
  const completion = vm.resolvePromise(result.value);
  pump();
  const settled = await completion;
  result.value.dispose();
  if (settled.error) {
    const error = vm.dump(settled.error);
    if (settled.error.alive) settled.error.dispose();
    current.result = {
      result: undefined,
      error: error?.message ? `${error.name}: ${error.message}` : String(error),
    };
    current.reset = error?.name === "InternalError";
  } else {
    // Async global evaluation resolves its completion as { value }.
    const handle = vm.getProp(settled.value, "value");
    const value: unknown = vm.dump(handle);
    // QuickJS 0.31 dump consumes Promise handles, but leaves other handles alive.
    if (handle.alive) handle.dispose();
    settled.value.dispose();
    const text = errore.try({
      try: () => JSON.stringify(value),
      catch: (cause) => new ResultSerializationError({ cause }),
    });
    current.result =
      text instanceof Error
        ? { result: undefined, error: text.message }
        : text === undefined && value !== undefined
          ? {
              result: undefined,
              error: new ResultSerializationError({}).message,
            }
          : text && text.length > 1024 * 1024
            ? { result: undefined, error: "Exec result exceeded 1 MiB" }
            : { result: text === undefined ? undefined : JSON.parse(text) };
  }
  finish();
});
