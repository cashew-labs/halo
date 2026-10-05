import { ORPCError } from "@orpc/client";
import { useConnection } from "../../api/ConnectionContext.js";
import { sessionError } from "./sessionView.js";
import { useContext, useEffect, useRef, useState } from "react";
import * as errore from "errore";
import { useQueryClient } from "@tanstack/react-query";
import {
  emptySessionSnapshot,
  reduceSessionUpdate,
  type SessionSnapshot,
  type SessionWatchItem,
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

type UseAgentSessionResult = {
  state: SessionSnapshot;
  error: string | undefined;
  prompt: (input: ChatPrompt) => Promise<void | PromptFailedError>;
  abort: () => Promise<void | AbortFailedError>;
};

export function useAgentSession(
  sessionId: string | undefined,
): UseAgentSessionResult {
  const api = useApi();
  const { service, state: connection } = useConnection();
  const enabled = connection.status === "connected";
  const isTabVisible = useContext(TabVisibilityContext);
  const queryClient = useQueryClient();
  const queryClientRef = useRef(queryClient);
  const [readyApi, setReadyApi] = useState<typeof api>();
  const [readySessionId, setReadySessionId] = useState<string | undefined>(
    undefined,
  );
  const [state, setState] = useState<SessionSnapshot>(
    () =>
      queryClient.getQueryData<SessionSnapshot>(
        draftSessionSnapshotQueryKey(sessionId),
      ) ?? emptySessionSnapshot(),
  );
  const stateRef = useRef(state);
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [openedFor, setOpenedFor] = useState(sessionId);

  if (openedFor !== sessionId) {
    setOpenedFor(sessionId);
    setReadySessionId(undefined);
    setState(emptySessionSnapshot());
    setLocalError(undefined);
  }

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    // Hidden tabs retain their UI state, but must release HTTP streams so new
    // chats and prompts are not blocked by the browser's connection limit.
    if (sessionId === undefined || !isTabVisible || !enabled) return;
    const controller = new AbortController();

    const updates = new Stream<SessionWatchItem>();
    const states = updates.project(stateRef.current, reduceSessionUpdate);
    const unsubscribe = states.subscribe(() => setState(states.latestValue));
    reconnectStream({
      name: "Session event",
      onError: (error) => service.fail(api, error),
      signal: controller.signal,
      open: async () =>
        await api.thread.events({ sessionId }, { signal: controller.signal }),
      onItem: (item) => {
        if (item.type === "snapshot") {
          queryClientRef.current.removeQueries({
            queryKey: draftSessionSnapshotQueryKey(sessionId),
            exact: true,
          });
          setReadySessionId(sessionId);
          setReadyApi(() => api);
          for (const sessionConnection of item.snapshot.connections) {
            queryClientRef.current.setQueryData<ConnectionState>(
              connectionStateQueryKey(sessionId, sessionConnection.request),
              connectionStateFromServer(sessionConnection),
            );
          }
        }
        if (item.type === "event" && item.event.type === "halo.connection") {
          const event = item.event;
          queryClientRef.current.setQueryData<ConnectionState>(
            connectionStateQueryKey(sessionId, event.request),
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
  }, [api, sessionId, isTabVisible, service, enabled]);

  async function prompt(input: ChatPrompt) {
    if (readySessionId === undefined || !enabled || readyApi !== api) {
      const error = new PromptFailedError({
        reason: "This chat is still connecting. Please try again in a moment.",
      });
      if (enabled) setLocalError(error.message);
      return error;
    }
    setLocalError(undefined);
    const result = await api.thread
      .prompt({ sessionId: readySessionId, ...input })
      .then(() => undefined)
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
    // running this prompt; reconnect the session stream without resending it.
    if (errore.isAbortError(result?.cause)) return result;
    if (result instanceof PromptFailedError) {
      if (service.getSnapshot().status !== "connected") return result;
      console.warn("Failed to send message:", result);
      setLocalError(result.message);
      return result;
    }
  }

  async function abort() {
    if (readySessionId === undefined) return;
    const result = await api.thread
      .abort({ sessionId: readySessionId })
      .then(() => undefined)
      .catch(
        (e) =>
          new AbortFailedError({
            reason: e instanceof Error ? e.message : String(e),
            cause: e,
          }),
      );
    if (result instanceof AbortFailedError) {
      console.warn("Failed to stop session:", result);
      return result;
    }
  }

  return {
    state,
    error: localError === undefined ? sessionError(state) : localError,
    prompt,
    abort,
  };
}

type UseDraftAgentSessionResult = {
  state: SessionSnapshot;
  error: string | undefined;
  sessionId: string | undefined;
  title: string | undefined;
  prompt: (input: ChatPrompt) => Promise<void | PromptFailedError>;
  abort: () => Promise<void | AbortFailedError>;
};

export function sessionTitleQueryKey(sessionId: string) {
  return ["session-title", sessionId] as const;
}

function draftSessionSnapshotQueryKey(sessionId: string | undefined) {
  return ["draft-session-snapshot", sessionId] as const;
}

export function useDraftAgentSession(
  onAccepted: (sessionId: string) => void,
): UseDraftAgentSessionResult {
  const api = useApi();
  const { service } = useConnection();
  const queryClient = useQueryClient();
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState<string>();
  const sessionIdRef = useRef<string | undefined>(undefined);
  const onAcceptedRef = useRef(onAccepted);
  const { state, error, abort } = useAgentSession(sessionId);
  const hasMessages = state.entries.length > 0;

  useEffect(() => {
    onAcceptedRef.current = onAccepted;
  }, [onAccepted]);

  useEffect(() => {
    if (sessionId === undefined || !hasMessages) return;
    // Navigation remounts the session pane. Keep its confirmed transcript visible
    // until the replacement subscription delivers a fresh snapshot.
    queryClient.setQueryData(draftSessionSnapshotQueryKey(sessionId), state);
    onAcceptedRef.current(sessionId);
  }, [sessionId, hasMessages, queryClient, state]);

  async function prompt(input: ChatPrompt) {
    setLocalError(undefined);
    if (service.getSnapshot().status !== "connected")
      return new PromptFailedError({
        reason: "This chat is still connecting. Please try again in a moment.",
      });
    const submittedTitle = chatPromptTitle(input);
    setTitle(submittedTitle);
    if (sessionIdRef.current === undefined) {
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
      sessionIdRef.current = created.sessionId;
      setSessionId(created.sessionId);
    }

    queryClient.setQueryData(
      sessionTitleQueryKey(sessionIdRef.current),
      submittedTitle,
    );
    const result = await api.thread
      .prompt({ sessionId: sessionIdRef.current, ...input })
      .then(() => undefined)
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
    if (errore.isAbortError(result?.cause)) return result;
    if (result instanceof PromptFailedError) {
      if (service.getSnapshot().status !== "connected") return result;
      console.warn("Failed to send message:", result);
      setLocalError(result.message);
      setTitle(undefined);
      return result;
    }
  }

  return {
    state,
    error: localError === undefined ? error : localError,
    sessionId,
    title,
    prompt,
    abort,
  };
}
