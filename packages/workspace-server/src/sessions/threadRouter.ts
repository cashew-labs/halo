import { implement } from "@orpc/server";
import { runWithSignal } from "@orpc/shared";
import type { Logger } from "@get-halo/logger";
import {
  contract,
  connectionRequestLabel,
  type ConnectionRequest,
} from "@get-halo/client";
import { PromptFailedError } from "../agent/Thread.js";
import type { ConnectionService } from "../agent/runtime/ConnectionService.js";
import { orpcErrors } from "../orpcErrors.js";
import type { ThreadManager } from "./ThreadManager.js";

export type ThreadRouterContext = {
  sessions: ThreadManager;
  connections: ConnectionService;
  logger: Logger;
};

const os = implement(contract.thread).$context<ThreadRouterContext>();

export const threadRouter = os.router({
  watchSummaries: os.watchSummaries.handler(({ context, signal }) =>
    context.sessions.watchSummaries(signal),
  ),
  markRead: os.markRead.handler(async ({ input, context }) => {
    const marked = await context.sessions.markRead(input);
    if (marked instanceof Error) return orpcErrors.badRequest(marked);
  }),
  markUnread: os.markUnread.handler(async ({ input, context }) => {
    const marked = await context.sessions.markUnread(input.sessionId);
    if (marked instanceof Error) return orpcErrors.badRequest(marked);
  }),
  markDone: os.markDone.handler(async ({ input, context }) => {
    const marked = await context.sessions.markDone(input.sessionId);
    if (marked instanceof Error) return orpcErrors.badRequest(marked);
  }),
  markUndone: os.markUndone.handler(async ({ input, context }) => {
    const marked = await context.sessions.markUndone(input.sessionId);
    if (marked instanceof Error) return orpcErrors.badRequest(marked);
  }),
  list: os.list.handler(async ({ context }) => {
    context.logger.info({ event: "listSessions" });
    const sessions = await context.sessions.list();
    if (sessions instanceof Error) return orpcErrors.badRequest(sessions);
    return sessions;
  }),
  new: os.new.handler(async ({ input, context }) => {
    context.logger.info({ event: "newAgentSession" });
    const session = await context.sessions.new(input);
    if (session instanceof Error) return orpcErrors.badRequest(session);
    return { sessionId: session.sessionId };
  }),
  snapshot: os.snapshot.handler(async ({ input, context }) => {
    const snapshot = await context.sessions.snapshot(
      input.sessionId,
      context.connections.statesForSession(input.sessionId),
    );
    if (snapshot instanceof Error) return orpcErrors.badRequest(snapshot);
    return snapshot;
  }),
  events: os.events.handler(async function* ({ input, context, signal }) {
    const events = context.sessions.events(input.sessionId, {
      signal,
      readConnections: () =>
        context.connections.statesForSession(input.sessionId),
    });
    for await (const event of events) {
      if (event instanceof Error) throw orpcErrors.badRequest(event);
      yield event;
    }
  }),
  prompt: os.prompt.handler(async ({ input, context, signal }) => {
    context.logger.info({
      event: "prompt",
      sessionId: input.sessionId,
      textLength: input.text.length,
    });
    const prompted = await runWithSignal(
      signal,
      async () => await context.sessions.prompt(input),
    );
    if (prompted instanceof Error) return orpcErrors.badRequest(prompted);
    return prompted;
  }),
  wait: os.wait.handler(async ({ input, context, signal }) => {
    const settled = await context.sessions.wait(input, signal);
    if (settled instanceof Error) return orpcErrors.badRequest(settled);
    return settled;
  }),
  startConnection: os.startConnection.handler(
    async ({ input, context, signal }) => {
      context.logger.info({
        event: "agentSession.startConnection",
        sessionId: input.sessionId,
        integration: input.request.integration,
      });
      const started = await context.connections.startConnection({
        sessionId: input.sessionId,
        request: input.request,
        onEvent: async (event) => {
          const published = await context.sessions.publishConnectionEvent(
            input.sessionId,
            event,
          );
          if (published instanceof Error) return published;
          if (event.status === "connected") {
            notifyConnectedSession({
              sessions: context.sessions,
              sessionId: input.sessionId,
              request: event.request,
              signal: undefined,
            })
              .then((notified) => {
                if (!(notified instanceof Error)) return;
                context.logger.warn({
                  event: "agentSession.connectionNotificationFailed",
                  error: notified,
                });
              })
              .catch((error) => {
                context.logger.warn({
                  event: "agentSession.connectionNotificationFailed",
                  error,
                });
              });
          }
          return undefined;
        },
      });
      if (started instanceof Error) {
        context.logger.warn({
          event: "agentSession.startConnectionFailed",
          sessionId: input.sessionId,
          error: started,
        });
        return orpcErrors.badRequest(started);
      }
      if (started.status === "authorization-required") return started;
      const notified = await notifyConnectedSession({
        sessions: context.sessions,
        sessionId: input.sessionId,
        request: input.request,
        signal,
      });
      if (notified instanceof Error) return orpcErrors.badRequest(notified);
      return started;
    },
  ),
  cancelConnection: os.cancelConnection.handler(async ({ input, context }) => {
    context.logger.info({
      event: "agentSession.cancelConnection",
      sessionId: input.sessionId,
      connectionId: input.connectionId,
    });
    const cancelled = await context.connections.cancelConnection(input);
    if (cancelled instanceof Error) return orpcErrors.badRequest(cancelled);
  }),
  respondToToolApproval: os.respondToToolApproval.handler(
    async ({ input, context }) => {
      context.logger.info({
        event: "agentSession.respondToToolApproval",
        sessionId: input.sessionId,
        approvalId: input.approvalId,
        decision: input.decision,
      });
      const responded = await context.sessions.respondToToolApproval(input);
      if (responded instanceof Error) return orpcErrors.badRequest(responded);
    },
  ),
  abort: os.abort.handler(async ({ input, context }) => {
    context.logger.info({
      event: "abort",
      sessionId: input.sessionId,
    });
    const aborted = await context.sessions.abort(input.sessionId);
    if (aborted instanceof Error) return orpcErrors.badRequest(aborted);
  }),
  close: os.close.handler(async ({ input, context }) => {
    context.logger.info({
      event: "agentSession.close",
      sessionId: input.sessionId,
    });
    const closed = await context.sessions.close(input.sessionId);
    if (closed instanceof Error) return orpcErrors.badRequest(closed);
  }),
});

async function notifyConnectedSession(args: {
  sessions: ThreadManager;
  sessionId: string;
  request: ConnectionRequest;
  signal: AbortSignal | undefined;
}) {
  return await runWithSignal(
    args.signal,
    async () =>
      await args.sessions.notify(args.sessionId, {
        customType: "halo.integration.connected",
        content: `[System] The user connected ${connectionRequestLabel(args.request)}. You can now retry the operation that required this connection. Continue the user's last request.`,
      }),
  ).catch(
    (cause) =>
      new PromptFailedError({
        reason: "Connection notification interrupted",
        cause,
      }),
  );
}
