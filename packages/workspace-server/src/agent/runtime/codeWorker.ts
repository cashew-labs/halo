import { parentPort } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import {
  newQuickJSWASMModule,
  type QuickJSDeferredPromise,
} from "quickjs-emscripten";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import type { ExecuteResult } from "@executor-js/codemode-core";
import type {
  CodeWorkerRequest,
  CodeWorkerResponse,
} from "./codeWorkerProtocol.js";

// This module only runs in a worker. Guest code never receives Node objects.
const port = parentPort!;
const module = await newQuickJSWASMModule(variant);
const runtime = module.newRuntime();
runtime.setMemoryLimit(32 * 1024 * 1024);
runtime.setMaxStackSize(1024 * 1024);
const vm = runtime.newContext();
const pending = new Map<string, QuickJSDeferredPromise>();
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
  send({
    type: "toolCall",
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
  const proxy = (path) => new Proxy(function() {}, {
    get(_, key) {
      if (key === 'then' || typeof key === 'symbol') return undefined;
      return proxy(path ? path + '.' + key : key);
    },
    apply(_, receiver, args) { return invoke(path, args[0] ?? {}); }
  });
  Object.defineProperty(globalThis, 'tools', { value: proxy('') });
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
    settled.error.dispose();
    current.result = {
      result: undefined,
      error: error?.message ? `${error.name}: ${error.message}` : String(error),
    };
    current.reset = error?.name === "InternalError";
  } else {
    // SAFETY: async global evaluation resolves its completion as { value }.
    const value = vm.dump(settled.value) as { value?: unknown };
    settled.value.dispose();
    const text = JSON.stringify(value);
    current.result =
      text && text.length > 1024 * 1024
        ? { result: undefined, error: "Exec result exceeded 1 MiB" }
        : { result: value.value };
  }
  finish();
});
