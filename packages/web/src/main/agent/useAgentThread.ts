import { ORPCError } from "@orpc/client";
import { useConnection } from "../../api/ConnectionContext.js";
import { threadError } from "./threadView.js";
import { useContext, useEffect, useRef, useState } from "react";
import * as errore from "errore";
import { useQueryClient } from "@tanstack/react-query";
import {
  emptyThreadSnapshot,
  reduceThreadUpdate,
  type ThreadSnapshot,
  type ThreadWatchItem,
  type ChatPrompt,
  chatPromptTitle,
} from "@get-halo/client";
import { useApi } from "../../api/ApiProvider.tsx";
import { TabVisibilityContext } from "../../panes/WorkspacePanesProvider.js";
import { reconnectStream } from "../../api/reconnectStream.js";
import { Stream } from "@get-halo/shared/Stream";
import {
  applyConnectionEvent,
  connectionStateFromServer,
  connectionStateQueryKey,
  type ConnectionState,
} from "./ConnectionState.ts";

class PromptFailedError extends errore.createTaggedError({
  name: "PromptFailedError",
  message: "$reason",
}) {}

class AbortFailedError extends errore.createTaggedError({
  name: "AbortFailedError",
  message: "$reason",
}) {}

/** A prompt plus the attached files' names, which title a new thread. */
export type ThreadPrompt = ChatPrompt & {
  files?: readonly { name: string }[];
};

type UseAgentThreadResult = {
  state: ThreadSnapshot;
  error: string | undefined;
  prompt: (
    input: ThreadPrompt,
  ) => Promise<{ submissionId: number } | PromptFailedError>;
  abort: () => Promise<void | AbortFailedError>;
};

export function useAgentThread(
  threadId: string | undefined,
): UseAgentThreadResult {
  const api = useApi();
  const { service, state: connection } = useConnection();
  const enabled = connection.status === "connected";
  const isTabVisible = useContext(TabVisibilityContext);
  const queryClient = useQueryClient();
  const queryClientRef = useRef(queryClient);
  const [readyApi, setReadyApi] = useState<typeof api>();
  const [readyThreadId, setReadyThreadId] = useState<string | undefined>(
    undefined,
  );
  const [state, setState] = useState<ThreadSnapshot>(
    () =>
      queryClient.getQueryData<ThreadSnapshot>(
        draftThreadSnapshotQueryKey(threadId),
      ) ?? emptyThreadSnapshot(),
  );
  const stateRef = useRef(state);
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [openedFor, setOpenedFor] = useState(threadId);

  if (openedFor !== threadId) {
    setOpenedFor(threadId);
    setReadyThreadId(undefined);
    setState(emptyThreadSnapshot());
    setLocalError(undefined);
  }

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    // Hidden tabs retain their UI state, but must release HTTP streams so new
    // chats and prompts are not blocked by the browser's connection limit.
    if (threadId === undefined || !isTabVisible || !enabled) return;
    const controller = new AbortController();

    const updates = new Stream<ThreadWatchItem>();
    const states = updates.project(stateRef.current, reduceThreadUpdate);
    const unsubscribe = states.subscribe(() => setState(states.latestValue));
    reconnectStream({
      name: "Thread event",
      onError: (error) => service.fail(api, error),
      signal: controller.signal,
      open: async () =>
        await api.thread.events(
          { sessionId: threadId },
          { signal: controller.signal },
        ),
      onItem: (item) => {
        if (item.type === "snapshot") {
          queryClientRef.current.removeQueries({
            queryKey: draftThreadSnapshotQueryKey(threadId),
            exact: true,
          });
          setReadyThreadId(threadId);
          setReadyApi(() => api);
          for (const threadConnection of item.snapshot.connections) {
            queryClientRef.current.setQueryData<ConnectionState>(
              connectionStateQueryKey(threadId, threadConnection.request),
              connectionStateFromServer(threadConnection),
            );
          }
        }
        if (item.type === "event" && item.event.type === "halo.connection") {
          const event = item.event;
          queryClientRef.current.setQueryData<ConnectionState>(
            connectionStateQueryKey(threadId, event.request),
            (current) => applyConnectionEvent(current, event),
          );
        }
        updates.append(item);
      },
    });

    return () => {
      unsubscribe();
      states[Symbol.dispose]();
      controller.abort();
    };
  }, [api, threadId, isTabVisible, service, enabled]);

  async function prompt({ files: _files, ...input }: ThreadPrompt) {
    if (readyThreadId === undefined || !enabled || readyApi !== api) {
      const error = new PromptFailedError({
        reason: "This chat is still connecting. Please try again in a moment.",
      });
      if (enabled) setLocalError(error.message);
      return error;
    }
    setLocalError(undefined);
    const result = await api.thread
      .prompt({ sessionId: readyThreadId, ...input })
      .catch(
        (e) =>
          new PromptFailedError({
            reason:
              e instanceof ORPCError && e.code === "BAD_REQUEST"
                ? e.message
                : "Couldn't send your message. Please try again.",
            cause: e,
          }),
      );
    // The connection banner owns transport recovery. The server may still be
    // running this prompt; reconnect the thread stream without resending it.
    if (result instanceof Error && errore.isAbortError(result.cause))
      return result;
    if (result instanceof PromptFailedError) {
      if (service.getSnapshot().status !== "connected") return result;
      console.warn("Failed to send message:", result);
      setLocalError(result.message);
      return result;
    }
    return result;
  }

  async function abort() {
    if (readyThreadId === undefined) return;
    setLocalError(undefined);
    const result = await api.thread
      .abort({ sessionId: readyThreadId })
      .then(() => undefined)
      .catch(
        (e) =>
          new AbortFailedError({
            reason: e instanceof Error ? e.message : String(e),
            cause: e,
          }),
      );
    if (result instanceof AbortFailedError) {
      console.warn("Failed to stop thread:", result);
      return result;
    }
    return result;
  }

  return {
    state,
    error: localError === undefined ? threadError(state) : localError,
    prompt,
    abort,
  };
}

type UseDraftAgentThreadResult = {
  state: ThreadSnapshot;
  error: string | undefined;
  threadId: string | undefined;
  title: string | undefined;
  prompt: (
    input: ThreadPrompt,
  ) => Promise<{ submissionId: number } | PromptFailedError>;
  abort: () => Promise<void | AbortFailedError>;
};

export function threadTitleQueryKey(threadId: string) {
  return ["thread-title", threadId] as const;
}

function draftThreadSnapshotQueryKey(threadId: string | undefined) {
  return ["draft-thread-snapshot", threadId] as const;
}

export function useDraftAgentThread(
  onAccepted: (threadId: string) => void,
): UseDraftAgentThreadResult {
  const api = useApi();
  const { service } = useConnection();
  const queryClient = useQueryClient();
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState<string>();
  const threadIdRef = useRef<string | undefined>(undefined);
  const onAcceptedRef = useRef(onAccepted);
  const { state, error, abort } = useAgentThread(threadId);
  const hasMessages = state.entries.length > 0;

  useEffect(() => {
    onAcceptedRef.current = onAccepted;
  }, [onAccepted]);

  useEffect(() => {
    if (threadId === undefined || !hasMessages) return;
    // Navigation remounts the thread pane. Keep its confirmed transcript visible
    // until the replacement subscription delivers a fresh snapshot.
    queryClient.setQueryData(draftThreadSnapshotQueryKey(threadId), state);
    onAcceptedRef.current(threadId);
  }, [threadId, hasMessages, queryClient, state]);

  async function prompt({ files, ...input }: ThreadPrompt) {
    setLocalError(undefined);
    if (service.getSnapshot().status !== "connected")
      return new PromptFailedError({
        reason: "This chat is still connecting. Please try again in a moment.",
      });
    const submittedTitle = chatPromptTitle({ ...input, files });
    setTitle(submittedTitle);
    if (threadIdRef.current === undefined) {
      const created = await api.thread.new().catch(
        (e) =>
          new PromptFailedError({
            reason: "Couldn't start this chat. Please try again.",
            cause: e,
          }),
      );
      if (
        created instanceof PromptFailedError &&
        errore.isAbortError(created.cause)
      )
        return created;
      if (created instanceof Error) {
        if (service.getSnapshot().status !== "connected") return created;
        console.warn("Failed to start chat:", created);
        setLocalError(created.message);
        setTitle(undefined);
        return created;
      }
      threadIdRef.current = created.sessionId;
      setThreadId(created.sessionId);
    }

    queryClient.setQueryData(
      threadTitleQueryKey(threadIdRef.current),
      submittedTitle,
    );
    const result = await api.thread
      .prompt({ sessionId: threadIdRef.current, ...input })
      .catch(
        (e) =>
          new PromptFailedError({
            reason:
              e instanceof ORPCError && e.code === "BAD_REQUEST"
                ? e.message
                : "Couldn't send your message. Please try again.",
            cause: e,
          }),
      );
    if (result instanceof Error && errore.isAbortError(result.cause))
      return result;
    if (result instanceof PromptFailedError) {
      if (service.getSnapshot().status !== "connected") return result;
      console.warn("Failed to send message:", result);
      setLocalError(result.message);
      setTitle(undefined);
      return result;
    }
    return result;
  }

  return {
    state,
    error: localError === undefined ? error : localError,
    threadId,
    title,
    prompt,
    abort,
  };
}
