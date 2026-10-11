import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { AsyncResource } from "node:async_hooks";
import { Effect } from "@executor-js/sdk/core";
import type {
  ExecuteResult,
  SandboxToolInvoker,
} from "@executor-js/codemode-core";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import * as errore from "errore";
import type {
  CodeWorkerRequest,
  CodeWorkerResponse,
} from "./codeWorkerProtocol.js";

class CodeSessionStopped extends errore.createTaggedError({
  name: "CodeSessionStopped",
  message:
    "Exec session reset: $reason. Previous bindings are unavailable; external effects may have completed.",
  extends: errore.AbortError,
}) {}

class CodeWorkerError extends errore.createTaggedError({
  name: "CodeWorkerError",
  message: "Exec worker failed",
}) {}

type Session = {
  worker: Worker;
  queue: SerialQueue;
  stopped: boolean;
  stop: (reason: string) => Promise<void>;
  cancel?: (reason: string) => void;
};

type Completion = { resolve?: (value: ExecuteResult) => void };

/** One lazy worker per loaded thread. Extensions never enter this evaluator. */
export class WorkerCodeExecutor {
  private readonly sessions = new Map<string, Session>();

  async reset(threadId: string) {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.sessions.delete(threadId);
    await session.stop("session disposed");
  }

  async close() {
    await Promise.all(
      [...this.sessions.keys()].map(async (id) => await this.reset(id)),
    );
  }

  async evaluate(input: {
    threadId: string;
    code: string;
    invoker: SandboxToolInvoker;
    signal?: AbortSignal;
  }): Promise<ExecuteResult> {
    if (input.signal?.aborted)
      return {
        result: undefined,
        error: "Execution cancelled before evaluation",
      };
    const session =
      this.sessions.get(input.threadId) ?? this.create(input.threadId);
    return await session.queue.run(async () => {
      if (session.stopped || input.signal?.aborted)
        return {
          result: undefined,
          error:
            "Exec session stopped before evaluation; code was not executed",
        };
      const result = await this.run({ ...input, session });
      return result;
    });
  }

  private create(threadId: string) {
    // tsImport supports the same source-based deployment as workspace-server.
    const worker = new Worker(
      `const { workerData } = require('node:worker_threads');
import('tsx/esm/api').then(({ tsImport }) => tsImport(workerData.moduleUrl, workerData.parentUrl));`,
      {
        eval: true,
        workerData: {
          moduleUrl: new URL("./codeWorker.ts", import.meta.url).href,
          parentUrl: import.meta.url,
        },
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      },
    );
    const session: Session = {
      worker,
      queue: new SerialQueue(),
      stopped: false,
      stop: async (reason) => {
        if (session.stopped) return;
        session.stopped = true;
        session.cancel?.(reason);
        if (this.sessions.get(threadId) === session)
          this.sessions.delete(threadId);
        const stopped = await worker
          .terminate()
          .catch((cause) => new CodeWorkerError({ cause }));
        if (stopped instanceof Error) console.warn(stopped);
      },
    };
    // Also handle failures/exits between evaluations.
    worker.on("error", async (cause) => {
      console.warn(new CodeWorkerError({ cause }));
      await session.stop("worker failed");
    });
    worker.on("exit", async () => {
      await session.stop("worker exited");
    });
    this.sessions.set(threadId, session);
    return session;
  }

  private async run(input: {
    session: Session;
    code: string;
    invoker: SandboxToolInvoker;
    signal?: AbortSignal;
  }): Promise<ExecuteResult> {
    const { session } = input;
    const id = randomUUID();
    const controller = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    const tools = new Set<Promise<void>>();
    const completion: Completion = {};
    const completed = new Promise<ExecuteResult>((resolve) => {
      completion.resolve = resolve;
    });
    let settled = false;
    const settle = (result: ExecuteResult) => {
      if (settled) return;
      settled = true;
      completion.resolve!(result);
    };
    session.cancel = (reason) => {
      const error = new CodeSessionStopped({ reason });
      controller.abort(error);
      settle({ result: undefined, error: error.message });
    };
    const abort = async () => {
      await session.stop("execution cancelled");
    };
    signal.addEventListener("abort", abort, { once: true });
    // Bounds unresolved guest promises and host tools as well as CPU execution.
    const timer = setTimeout(async () => {
      await session.stop("evaluation exceeded five minutes");
    }, 300_000);
    const send = async (message: CodeWorkerRequest) => {
      const sent = errore.try({
        // Worker messages have no browser target origin.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        try: () => session.worker.postMessage(message),
        catch: (cause) => new CodeWorkerError({ cause }),
      });
      if (sent instanceof Error) {
        console.warn(sent);
        await session.stop("worker message failed");
      }
    };
    const receive = async (message: CodeWorkerResponse) => {
      if (settled || message.id !== id) return;
      if (message.type === "completed") {
        settle(
          message.reset
            ? {
                ...message.result,
                error: `${message.result.error}\nExec session reset; previous bindings are unavailable.`,
              }
            : message.result,
        );
        if (message.reset) await session.stop("guest runtime failed");
        return;
      }
      const task = Effect.runPromise(
        input.invoker.invoke({ path: message.path, args: message.args }),
        { signal },
      )
        .catch((cause) => new CodeWorkerError({ cause }))
        .then(async (value) => {
          if (settled || session.stopped) return;
          await send({
            type: "toolResult",
            id,
            invocationId: message.invocationId,
            value:
              value instanceof Error
                ? {
                    ok: false,
                    error: { code: value.name, message: value.message },
                  }
                : value,
          });
        });
      tools.add(task);
      await task;
      tools.delete(task);
    };
    const boundReceive = AsyncResource.bind(receive);
    session.worker.on("message", boundReceive);
    await send({ type: "evaluate", id, code: input.code });
    if (signal.aborted) await abort();
    const result = await completed;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    session.worker.off("message", boundReceive);
    session.cancel = undefined;
    await Promise.all(tools);
    return result;
  }
}
