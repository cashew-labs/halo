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
  threads: ThreadManager;
  connections: ConnectionService;
  logger: Logger;
};

const os = implement(contract.thread).$context<ThreadRouterContext>();

export const threadRouter = os.router({
  watchSummaries: os.watchSummaries.handler(({ context, signal }) =>
    context.threads.watchSummaries(signal),
  ),
  markRead: os.markRead.handler(
    async ({ input: { sessionId: threadId, ...input }, context }) => {
      const marked = await context.threads.markRead({ threadId, ...input });
      if (marked instanceof Error) return orpcErrors.badRequest(marked);
    },
  ),
  markUnread: os.markUnread.handler(
    async ({ input: { sessionId: threadId }, context }) => {
      const marked = await context.threads.markUnread(threadId);
      if (marked instanceof Error) return orpcErrors.badRequest(marked);
    },
  ),
  markDone: os.markDone.handler(
    async ({ input: { sessionId: threadId }, context }) => {
      const marked = await context.threads.markDone(threadId);
      if (marked instanceof Error) return orpcErrors.badRequest(marked);
    },
  ),
  markUndone: os.markUndone.handler(
    async ({ input: { sessionId: threadId }, context }) => {
      const marked = await context.threads.markUndone(threadId);
      if (marked instanceof Error) return orpcErrors.badRequest(marked);
    },
  ),
  list: os.list.handler(async ({ context }) => {
    context.logger.info({ event: "listThreads" });
    const threads = await context.threads.list();
    if (threads instanceof Error) return orpcErrors.badRequest(threads);
    return threads;
  }),
  new: os.new.handler(async ({ input, context }) => {
    context.logger.info({ event: "newAgentThread" });
    const thread = await context.threads.new({ requestId: input?.requestId });
    if (thread instanceof Error) return orpcErrors.badRequest(thread);
    return { sessionId: thread.threadId };
  }),
  snapshot: os.snapshot.handler(
    async ({ input: { sessionId: threadId }, context }) => {
      const snapshot = await context.threads.snapshot(
        threadId,
        context.connections.statesForThread(threadId),
      );
      if (snapshot instanceof Error) return orpcErrors.badRequest(snapshot);
      return snapshot;
    },
  ),
  events: os.events.handler(async function* ({
    input: { sessionId: threadId },
    context,
    signal,
  }) {
    const events = context.threads.events(threadId, {
      signal,
      readConnections: () => context.connections.statesForThread(threadId),
    });
    for await (const event of events) {
      if (event instanceof Error) throw orpcErrors.badRequest(event);
      yield event;
    }
  }),
  prompt: os.prompt.handler(
    async ({ input: { sessionId: threadId, ...input }, context, signal }) => {
      context.logger.info({
        event: "prompt",
        threadId,
        textLength: input.text.length,
      });
      // Protocol 29 clients send `files`, empty for text-only messages. Reject
      // attachments instead of accepting the message without them.
      // SAFETY: The contract omits this legacy field; it is checked below.
      const { files: legacyFiles, ...prompt } = input as typeof input & {
        files?: unknown;
      };
      if (Array.isArray(legacyFiles) && legacyFiles.length > 0)
        return orpcErrors.badRequest(
          new PromptFailedError({ reason: "Update Halo to attach files." }),
        );
      const prompted = await runWithSignal(
        signal,
        async () => await context.threads.prompt({ threadId, ...prompt }),
      );
      if (prompted instanceof Error) return orpcErrors.badRequest(prompted);
      return prompted;
    },
  ),
  withdraw: os.withdraw.handler(
    async ({ input: { sessionId: threadId, ...input }, context }) => {
      const withdrawn = await context.threads.withdraw({ threadId, ...input });
      if (withdrawn instanceof Error) return orpcErrors.badRequest(withdrawn);
      return withdrawn;
    },
  ),
  wait: os.wait.handler(
    async ({ input: { sessionId: threadId, ...input }, context, signal }) => {
      const settled = await context.threads.wait(
        { threadId, ...input },
        signal,
      );
      if (settled instanceof Error) return orpcErrors.badRequest(settled);
      return settled;
    },
  ),
  startConnection: os.startConnection.handler(
    async ({ input: { sessionId: threadId, ...input }, context, signal }) => {
      context.logger.info({
        event: "agentThread.startConnection",
        threadId,
        integration: input.request.integration,
      });
      const started = await context.connections.startConnection({
        threadId,
        request: input.request,
        legacyClient: input.completion !== undefined,
        onEvent: async (event) => {
          const published = await context.threads.publishConnectionEvent(
            threadId,
            event,
          );
          if (published instanceof Error) return published;
          if (event.status === "connected") {
            notifyConnectedThread({
              threads: context.threads,
              threadId,
              request: event.request,
              signal: undefined,
            })
              .then((notified) => {
                if (!(notified instanceof Error)) return;
                context.logger.warn({
                  event: "agentThread.connectionNotificationFailed",
                  error: notified,
                });
              })
              .catch((error) => {
                context.logger.warn({
                  event: "agentThread.connectionNotificationFailed",
                  error,
                });
              });
          }
          return undefined;
        },
      });
      if (started instanceof Error) {
        context.logger.warn({
          event: "agentThread.startConnectionFailed",
          threadId,
          error: started,
        });
        return orpcErrors.badRequest(started);
      }
      if (started.status === "authorization-required") return started;
      const notified = await notifyConnectedThread({
        threads: context.threads,
        threadId,
        request: input.request,
        signal,
      });
      if (notified instanceof Error) return orpcErrors.badRequest(notified);
      return started;
    },
  ),
  completeOAuth: os.completeOAuth.handler(() =>
    orpcErrors.badRequest(
      new Error(
        "This connection attempt expired when the workspace was upgraded. Connect again to finish authorization in Halo.",
      ),
    ),
  ),
  cancelConnection: os.cancelConnection.handler(
    async ({ input: { sessionId: threadId, ...input }, context }) => {
      context.logger.info({
        event: "agentThread.cancelConnection",
        threadId,
        connectionId: input.connectionId,
      });
      const cancelled = await context.connections.cancelConnection({
        threadId,
        ...input,
      });
      if (cancelled instanceof Error) return orpcErrors.badRequest(cancelled);
    },
  ),
  respondToToolApproval: os.respondToToolApproval.handler(
    async ({ input: { sessionId: threadId, ...input }, context }) => {
      context.logger.info({
        event: "agentThread.respondToToolApproval",
        threadId,
        approvalId: input.approvalId,
        decision: input.decision,
      });
      const responded = await context.threads.respondToToolApproval({
        threadId,
        ...input,
      });
      if (responded instanceof Error) return orpcErrors.badRequest(responded);
    },
  ),
  abort: os.abort.handler(
    async ({ input: { sessionId: threadId }, context }) => {
      context.logger.info({
        event: "abort",
        threadId,
      });
      const aborted = await context.threads.abort(threadId);
      if (aborted instanceof Error) return orpcErrors.badRequest(aborted);
    },
  ),
  close: os.close.handler(
    async ({ input: { sessionId: threadId }, context }) => {
      context.logger.info({
        event: "agentThread.close",
        threadId,
      });
      const closed = await context.threads.close(threadId);
      if (closed instanceof Error) return orpcErrors.badRequest(closed);
    },
  ),
});

async function notifyConnectedThread(args: {
  threads: ThreadManager;
  threadId: string;
  request: ConnectionRequest;
  signal: AbortSignal | undefined;
}) {
  return await runWithSignal(
    args.signal,
    async () =>
      await args.threads.notify(args.threadId, {
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
