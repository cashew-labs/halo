import { implement } from "@orpc/server";
import { runWithSignal } from "@orpc/shared";
import type { Logger } from "@get-halo/logger";
import { contract } from "@get-halo/shared/contract";
import {
  connectionRequestLabel,
  type ConnectionRequest,
} from "@get-halo/shared/ConnectionRequest";
import {
  PromptFailedError,
  type HaloAgentSession,
} from "../agent/HaloAgentSession.js";
import type { ConnectionService } from "../agent/runtime/ConnectionService.js";
import { orpcErrors } from "../orpcErrors.js";
import type { SessionRegistry } from "./SessionRegistry.js";

export type SessionsRouterContext = {
  sessions: SessionRegistry;
  connections: ConnectionService;
  logger: Logger;
};

const os = implement(contract.sessions).$context<SessionsRouterContext>();

export const sessionsRouter = os.router({
  list: os.list.handler(async ({ context }) => {
    context.logger.info({ event: "listSessions" });
    const sessions = await context.sessions.list();
    if (sessions instanceof Error) return orpcErrors.badRequest(sessions);
    return sessions;
  }),
  create: os.create.handler(async ({ context }) => {
    context.logger.info({ event: "newAgentSession" });
    const session = await context.sessions.create();
    if (session instanceof Error) return orpcErrors.badRequest(session);
    return { sessionId: session.sessionId };
  }),
  snapshot: os.snapshot.handler(async ({ input, context }) => {
    const session = await context.sessions.open(input.sessionId);
    if (session instanceof Error) return orpcErrors.badRequest(session);
    const snapshot = await session.readSnapshot(
      context.connections.statesForSession(input.sessionId),
    );
    if (snapshot instanceof Error) return orpcErrors.badRequest(snapshot);
    return snapshot;
  }),
  watch: os.watch.handler(async ({ input, context, signal }) => {
    const session = await context.sessions.open(input.sessionId);
    if (session instanceof Error) return orpcErrors.badRequest(session);
    return session.watch({
      signal,
      readConnections: () =>
        context.connections.statesForSession(input.sessionId),
    });
  }),
  prompt: os.prompt.handler(async ({ input, context, signal }) => {
    context.logger.info({
      event: "prompt",
      sessionId: input.sessionId,
      textLength: input.text.length,
    });
    const session = await context.sessions.open(input.sessionId);
    if (session instanceof Error) return orpcErrors.badRequest(session);
    const prompted = await runWithSignal(
      signal,
      async () => await session.prompt(input.text),
    );
    if (prompted instanceof Error) return orpcErrors.badRequest(prompted);
  }),
  startConnection: os.startConnection.handler(
    async ({ input, context, signal }) => {
      context.logger.info({
        event: "agentSession.startConnection",
        sessionId: input.sessionId,
        integration: input.request.integration,
      });
      const session = await context.sessions.open(input.sessionId);
      if (session instanceof Error) return orpcErrors.badRequest(session);
      const started = await context.connections.startConnection({
        sessionId: input.sessionId,
        request: input.request,
        completion: input.completion,
        onEvent: async (event) => {
          session.publishConnectionEvent(event);
          if (event.status === "connected") {
            notifyConnectedSession({
              session,
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
        session,
        request: input.request,
        signal,
      });
      if (notified instanceof Error) return orpcErrors.badRequest(notified);
      return started;
    },
  ),
  completeOAuth: os.completeOAuth.handler(async ({ input, context }) => {
    context.logger.info({ event: "agentSession.completeOAuth" });
    const completed = await context.connections.completeOAuth(input);
    if (completed instanceof Error) return orpcErrors.badRequest(completed);
  }),
  cancelConnection: os.cancelConnection.handler(async ({ input, context }) => {
    context.logger.info({
      event: "agentSession.cancelConnection",
      sessionId: input.sessionId,
      connectionId: input.connectionId,
    });
    const cancelled = await context.connections.cancelConnection(input);
    if (cancelled instanceof Error) return orpcErrors.badRequest(cancelled);
  }),
  abort: os.abort.handler(async ({ input, context }) => {
    context.logger.info({
      event: "abort",
      sessionId: input.sessionId,
    });
    const session = await context.sessions.open(input.sessionId);
    if (session instanceof Error) return orpcErrors.badRequest(session);
    const aborted = await session.abort();
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
  session: HaloAgentSession;
  request: ConnectionRequest;
  signal: AbortSignal | undefined;
}) {
  return await runWithSignal(
    args.signal,
    async () =>
      await args.session.notify({
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
