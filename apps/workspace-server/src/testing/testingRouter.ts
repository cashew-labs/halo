import { implement } from "@orpc/server";
import * as errore from "errore";
import { contract } from "@get-halo/client";
import { orpcErrors } from "../orpcErrors.js";
import type { SessionRegistry } from "../sessions/SessionRegistry.js";
import type { ToolRuntime } from "../agent/runtime/ToolRuntime.js";

class TestingApiUnavailableError extends errore.createTaggedError({
  name: "TestingApiUnavailableError",
  message: "The testing API is unavailable outside an E2E run.",
}) {}

class TestingToolNotFoundError extends errore.createTaggedError({
  name: "TestingToolNotFoundError",
  message: "Executor has no user-facing tool at '$path'.",
}) {}

class TestingToolInvocationError extends errore.createTaggedError({
  name: "TestingToolInvocationError",
  message: "Tool '$path' failed: $detail",
}) {}

export type TestingRouterContext = {
  sessions: SessionRegistry;
  toolRuntime: ToolRuntime;
  testingApiEnabled: boolean;
};

const os = implement(contract.testHarness).$context<TestingRouterContext>();

export const testingRouter = os.router({
  loadSession: os.loadSession.handler(async ({ input, context }) => {
    if (!context.testingApiEnabled)
      return orpcErrors.badRequest(new TestingApiUnavailableError());
    const session = await context.sessions.create();
    if (session instanceof Error) return orpcErrors.badRequest(session);
    const named = await session.setName(input.title);
    if (named instanceof Error) return orpcErrors.badRequest(named);
    const appended = await session.appendMessages(input.messages);
    if (appended instanceof Error) return orpcErrors.badRequest(appended);
    const closed = await context.sessions.close(session.sessionId);
    if (closed instanceof Error) return orpcErrors.badRequest(closed);
    return { sessionId: session.sessionId };
  }),
  invokeTool: os.invokeTool.handler(async ({ input, context, signal }) => {
    if (!context.testingApiEnabled) {
      return orpcErrors.badRequest(new TestingApiUnavailableError());
    }
    const runtime = context.toolRuntime;
    const result = await runtime.invokePath({
      path: input.path,
      args: input.input,
      signal,
    });
    if (result instanceof Error) return orpcErrors.badRequest(result);
    if (!result.ok) {
      return orpcErrors.badRequest(
        new TestingToolInvocationError({
          path: input.path,
          detail: result.error.message,
        }),
      );
    }
    return result.data;
  }),
  getToolIdentity: os.getToolIdentity.handler(async ({ input, context }) => {
    if (!context.testingApiEnabled) {
      return orpcErrors.badRequest(new TestingApiUnavailableError());
    }
    const runtime = context.toolRuntime;
    const identity = runtime.getToolIdentity(input.path);
    if (identity === undefined) {
      return orpcErrors.badRequest(
        new TestingToolNotFoundError({ path: input.path }),
      );
    }
    return identity;
  }),
});
