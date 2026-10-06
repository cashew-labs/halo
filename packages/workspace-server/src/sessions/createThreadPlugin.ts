import { Type } from "@sinclair/typebox";
import * as errore from "errore";
import type { ConnectionService } from "../agent/runtime/ConnectionService.js";
import {
  defineHaloTool,
  type HaloToolPlugin,
} from "../agent/tools/HaloToolPlugin.js";
import type { ThreadManager } from "./ThreadManager.js";

const threadInput = Type.Object({ threadId: Type.String({ minLength: 1 }) });
const requestIdSchema = Type.String({ minLength: 1 });

class ThreadWaitTimeoutError extends errore.createTaggedError({
  name: "ThreadWaitTimeoutError",
  message: "Thread wait timed out",
  extends: errore.AbortError,
}) {}

// Resolve at invocation time: threads use the runtime that registers this plugin.
export function createThreadPlugin(
  services: () => { threads: ThreadManager; connections: ConnectionService },
): HaloToolPlugin {
  return {
    id: "thread",
    name: "Workspace threads",
    tools: [
      defineHaloTool({
        name: "list",
        description:
          "List all conversations in this workspace. Any workspace thread can be read or prompted; threads have no parent or owner relationship.",
        inputSchema: Type.Object({}),
        requiredCapabilities: ["workspace.threads.read"],
        execute: async () => {
          const result = await services().threads.list();
          if (result instanceof Error) return result;
          return {
            value: result.map(({ sessionId, ...summary }) => ({
              ...summary,
              threadId: sessionId,
            })),
          };
        },
      }),
      defineHaloTool({
        name: "new",
        description:
          "Create an independent, empty workspace thread. It uses workspace instructions and tools, not this conversation's history. Supply a unique requestId and reuse it only to retry the same creation; request IDs are workspace-wide. Then call thread.prompt to start work.",
        inputSchema: Type.Object({ requestId: requestIdSchema }),
        requiredCapabilities: ["workspace.threads.write"],
        execute: async (input) => {
          const result = await services().threads.new(input);
          if (result instanceof Error) return result;
          return { value: { threadId: result.sessionId } };
        },
      }),
      defineHaloTool({
        name: "snapshot",
        description:
          "Read the current projected state and conversation entries of any workspace thread. This is the whole thread's current state, not the result of a specific submission.",
        inputSchema: threadInput,
        requiredCapabilities: ["workspace.threads.read"],
        execute: async ({ threadId }) => {
          const { threads, connections } = services();
          const result = await threads.snapshot(
            threadId,
            connections.statesForSession(threadId),
          );
          if (result instanceof Error) return result;
          return { value: result };
        },
      }),
      defineHaloTool({
        name: "prompt",
        description:
          "Durably accept a message in any workspace thread and return its submissionId without waiting for a response. Busy threads receive steering input. Include all needed context explicitly. Reuse requestId only for retries of the same message; IDs are scoped to the target thread.",
        inputSchema: Type.Object({
          threadId: Type.String({ minLength: 1 }),
          requestId: requestIdSchema,
          text: Type.String({ minLength: 1 }),
        }),
        requiredCapabilities: ["workspace.threads.write"],
        execute: async ({ threadId, requestId, text }) => {
          const result = await services().threads.prompt({
            sessionId: threadId,
            clientMessageId: requestId,
            text,
          });
          if (result instanceof Error) return result;
          return { value: result };
        },
      }),
      defineHaloTool({
        name: "wait",
        description:
          "Wait for a specific submission to settle. Returns completed, aborted, failed, or pending when timeoutMs expires (default 1000, maximum 30000). Repeat after pending. Timeout or caller cancellation does not abort the target. Read thread.snapshot for conversation content; do not wait on your own unfinished submission.",
        inputSchema: Type.Object({
          threadId: Type.String({ minLength: 1 }),
          submissionId: Type.Integer({
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
          }),
          timeoutMs: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 30_000 }),
          ),
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
          const result = await services().threads.wait(
            { sessionId: threadId, submissionId },
            signal,
          );
          if (result instanceof Error) {
            if (
              errore.isAbortError(result) &&
              timeout.aborted &&
              !context.signal?.aborted
            )
              return { value: { status: "pending" } };
            return result;
          }
          return { value: result };
        },
      }),
      defineHaloTool({
        name: "abort",
        description:
          "Abort the current execution of any workspace thread. This affects the conversation, not just one submission. It does not delete the thread or prevent future prompts. Cancelling a wait alone does not abort work.",
        inputSchema: threadInput,
        requiredCapabilities: ["workspace.threads.write"],
        execute: async ({ threadId }) => {
          const result = await services().threads.abort(threadId);
          if (result instanceof Error) return result;
          return { value: { threadId } };
        },
      }),
    ],
  };
}
