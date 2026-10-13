import { Type } from "@sinclair/typebox";
import * as errore from "errore";
import { haloTool } from "../agent/tools/HaloTool.js";

const threadInput = Type.Object({ threadId: Type.String({ minLength: 1 }) });
const requestIdSchema = Type.String({ minLength: 1 });

class ThreadWaitTimeoutError extends errore.createTaggedError({
  name: "ThreadWaitTimeoutError",
  message: "Thread wait timed out",
  extends: errore.AbortError,
}) {}

export const threadTools = {
  list: haloTool({
    description:
      "List all conversations in this workspace. Any workspace thread can be read or prompted; threads have no parent or owner relationship.",
    inputSchema: Type.Object({}),
    requiredCapabilities: ["workspace.threads.read"],
    execute: async (_input, context) => {
      const result = await context.services.threads.list();
      if (result instanceof Error) return result;
      return {
        result: result.map(({ sessionId, ...summary }) => ({
          ...summary,
          threadId: sessionId,
        })),
      };
    },
  }),
  new: haloTool({
    description:
      "Create an independent, empty workspace thread. It uses workspace instructions and tools, not this conversation's history. Supply a unique requestId and reuse it only to retry the same creation; request IDs are workspace-wide. Then call thread.prompt to start work.",
    inputSchema: Type.Object({ requestId: requestIdSchema }),
    requiredCapabilities: ["workspace.threads.write"],
    execute: async (input, context) => {
      const result = await context.services.threads.new(input);
      if (result instanceof Error) return result;
      return { result: { threadId: result.sessionId } };
    },
  }),
  snapshot: haloTool({
    description:
      "Read the current projected state and conversation entries of any workspace thread. This is the whole thread's current state, not the result of a specific submission.",
    inputSchema: threadInput,
    requiredCapabilities: ["workspace.threads.read"],
    execute: async ({ threadId }, context) => {
      const { threads, connections } = context.services;
      const result = await threads.snapshot(
        threadId,
        connections.statesForSession(threadId),
      );
      if (result instanceof Error) return result;
      return { result };
    },
  }),
  prompt: haloTool({
    description:
      "Durably accept a message in any workspace thread and return its submissionId without waiting for a response. Busy threads receive steering input. Include all needed context explicitly. Reuse requestId only for retries of the same message; IDs are scoped to the target thread.",
    inputSchema: Type.Object({
      threadId: Type.String({ minLength: 1 }),
      requestId: requestIdSchema,
      text: Type.String({ minLength: 1 }),
    }),
    requiredCapabilities: ["workspace.threads.write"],
    execute: async ({ threadId, requestId, text }, context) => {
      const result = await context.services.threads.prompt({
        sessionId: threadId,
        clientMessageId: requestId,
        text,
      });
      if (result instanceof Error) return result;
      return { result };
    },
  }),
  wait: haloTool({
    description:
      "Wait for a specific submission to settle. Returns completed, aborted, failed, or pending when timeoutMs expires (default 1000, maximum 30000). Repeat after pending. Timeout or caller cancellation does not abort the target. Read thread.snapshot for conversation content; do not wait on your own unfinished submission.",
    inputSchema: Type.Object({
      threadId: Type.String({ minLength: 1 }),
      submissionId: Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      }),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 30_000 })),
    }),
    requiredCapabilities: ["workspace.threads.read"],
    execute: async ({ threadId, submissionId, timeoutMs }, context) => {
      using cleanup = new errore.DisposableStack();
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new ThreadWaitTimeoutError()),
        timeoutMs ?? 1_000,
      );
      cleanup.defer(() => clearTimeout(timer));
      const timeout = controller.signal;
      const signal =
        context.signal === undefined
          ? timeout
          : AbortSignal.any([context.signal, timeout]);
      const result = await context.services.threads.wait(
        { sessionId: threadId, submissionId },
        signal,
      );
      if (result instanceof Error) {
        if (
          errore.isAbortError(result) &&
          timeout.aborted &&
          !context.signal?.aborted
        )
          return { result: { status: "pending" } };
        return result;
      }
      return { result };
    },
  }),
  abort: haloTool({
    description:
      "Abort the current execution of any workspace thread. This affects the conversation, not just one submission. It does not delete the thread or prevent future prompts. Cancelling a wait alone does not abort work.",
    inputSchema: threadInput,
    requiredCapabilities: ["workspace.threads.write"],
    execute: async ({ threadId }, context) => {
      const result = await context.services.threads.abort(threadId);
      if (result instanceof Error) return result;
      return { result: { threadId } };
    },
  }),
};
