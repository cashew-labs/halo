import { implement } from "@orpc/server";
import { contract } from "@get-halo/client";
import type { Logger } from "@get-halo/logger";
import * as errore from "errore";
import { orpcErrors } from "../orpcErrors.js";
import type { SessionRegistry } from "../sessions/SessionRegistry.js";
import type { ToolRuntime } from "../agent/runtime/ToolRuntime.js";

class TestApiUnavailableError extends errore.createTaggedError({
  name: "TestApiUnavailableError",
  message: "The test API is disabled for this workspace server.",
}) {}

export type TestApiRouterContext = {
  sessions: SessionRegistry;
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

export const testApiRouter = os.router({
  seedSession: os.seedSession.handler(async ({ input, context }) => {
    const session = await context.sessions.create();
    if (session instanceof Error) throw orpcErrors.badRequest(session);
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const closed = await context.sessions.close(session.sessionId);
      if (closed instanceof Error)
        context.logger.warn({
          event: "seed-session-cleanup-failed",
          error: closed,
        });
    });
    const named = await session.setName(input.title);
    if (named instanceof Error) throw orpcErrors.badRequest(named);
    const appended = await session.appendMessages(input.messages);
    if (appended instanceof Error) throw orpcErrors.badRequest(appended);
    const closed = await context.sessions.close(session.sessionId);
    cleanup.move();
    if (closed instanceof Error) throw orpcErrors.badRequest(closed);
    return { sessionId: session.sessionId };
  }),
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
