import { implement } from "@orpc/server";
import { contract, type HaloMessage } from "@get-halo/client";
import type { Logger } from "@get-halo/logger";
import * as errore from "errore";
import { orpcErrors } from "../orpcErrors.js";
import type { ThreadManager } from "../threads/ThreadManager.js";
import type { ToolRuntime } from "../agent/runtime/ToolRuntime.js";

class TestApiUnavailableError extends errore.createTaggedError({
  name: "TestApiUnavailableError",
  message: "The test API is disabled for this workspace server.",
}) {}

export type TestApiRouterContext = {
  threads: ThreadManager;
  toolRuntime: ToolRuntime;
  logger: Logger;
  testApiEnabled: boolean;
};

const os = implement(contract.testApi)
  .$context<TestApiRouterContext>()
  .use(async ({ context, next }) => {
    if (!context.testApiEnabled)
      throw orpcErrors.badRequest(new TestApiUnavailableError());
    return await next();
  });

async function seedThread({
  input,
  context,
}: {
  input: { title: string; messages: HaloMessage[] };
  context: TestApiRouterContext;
}) {
  const thread = await context.threads.new();
  if (thread instanceof Error) throw orpcErrors.badRequest(thread);
  const { threadId } = thread;
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(async () => {
    const closed = await context.threads.close(threadId);
    if (closed instanceof Error)
      context.logger.warn({
        event: "seed-thread-cleanup-failed",
        error: closed,
      });
  });
  const named = await context.threads.setName(threadId, input.title);
  if (named instanceof Error) throw orpcErrors.badRequest(named);
  const appended = await context.threads.appendMessages(
    threadId,
    input.messages,
  );
  if (appended instanceof Error) throw orpcErrors.badRequest(appended);
  const closed = await context.threads.close(threadId);
  cleanup.move();
  if (closed instanceof Error) throw orpcErrors.badRequest(closed);
  return { sessionId: threadId };
}

export const testApiRouter = os.router({
  seedThread: os.seedThread.handler(seedThread),
  seedSession: os.seedSession.handler(seedThread),
  invokeTool: os.invokeTool.handler(
    async ({ input, context, signal, errors }) => {
      const result = await context.toolRuntime.invokePath({
        path: input.path,
        args: input.input,
        signal,
      });
      if (result instanceof Error) throw orpcErrors.badRequest(result);
      if (!result.ok)
        throw errors.BAD_REQUEST({
          message: result.error.message,
          data: { message: result.error.message },
        });
      return result.data;
    },
  ),
  getToolIdentity: os.getToolIdentity.handler(({ input, context, errors }) => {
    const identity = context.toolRuntime.getToolIdentity(input.path);
    if (identity === undefined)
      throw errors.BAD_REQUEST({
        message: `Executor has no user-facing tool at '${input.path}'.`,
        data: {
          message: `Executor has no user-facing tool at '${input.path}'.`,
        },
      });
    return identity;
  }),
});
