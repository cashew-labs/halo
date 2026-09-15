import { sessionError } from "./sessionView.js";
import { useEffect, useRef, useState } from "react";
import * as errore from "errore";
import { useQueryClient } from "@tanstack/react-query";
import {
  emptySessionSnapshot,
  reduceSessionUpdate,
  type SessionSnapshot,
  type SessionWatchItem,
} from "@get-halo/shared/sessionState";
import { useApi } from "../../api/ApiProvider.tsx";
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
  prompt: (text: string) => Promise<void | PromptFailedError>;
  abort: () => Promise<void | AbortFailedError>;
};

export function useAgentSession(
  sessionId: string | undefined,
): UseAgentSessionResult {
  const api = useApi();
  const queryClient = useQueryClient();
  const queryClientRef = useRef(queryClient);
  const [readySessionId, setReadySessionId] = useState<string | undefined>(
    undefined,
  );
  const [state, setState] = useState<SessionSnapshot>(emptySessionSnapshot);
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [openedFor, setOpenedFor] = useState(sessionId);

  if (openedFor !== sessionId) {
    setOpenedFor(sessionId);
    setReadySessionId(undefined);
    setState(emptySessionSnapshot());
    setLocalError(undefined);
  }

  useEffect(() => {
    if (sessionId === undefined) return;
    const controller = new AbortController();

    const updates = new Stream<SessionWatchItem>();
    const states = updates.project(emptySessionSnapshot(), reduceSessionUpdate);
    const unsubscribe = states.subscribe(setState);
    reconnectStream({
      name: "Session event",
      signal: controller.signal,
      open: async () =>
        await api.sessions.watch({ sessionId }, { signal: controller.signal }),
      onItem: (item) => {
        if (item.type === "snapshot") {
          setReadySessionId(sessionId);
          for (const connection of item.snapshot.connections) {
            queryClientRef.current.setQueryData<ConnectionState>(
              connectionStateQueryKey(sessionId, connection.request),
              connectionStateFromServer(connection),
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
      controller.abort();
    };
  }, [api, sessionId]);

  async function prompt(text: string) {
    if (readySessionId === undefined) {
      const error = new PromptFailedError({ reason: "Session is not ready." });
      setLocalError(error.message);
      return error;
    }
    setLocalError(undefined);
    const result = await api.sessions
      .prompt({ sessionId: readySessionId, text })
      .then(() => undefined)
      .catch(
        (e) =>
          new PromptFailedError({
            reason: e instanceof Error ? e.message : String(e),
            cause: e,
          }),
      );
    if (result instanceof PromptFailedError) {
      setLocalError(result.message);
      return result;
    }
    await queryClient.invalidateQueries({
      queryKey: ["sessions"],
      refetchType: "all",
    });
  }

  async function abort() {
    if (readySessionId === undefined) return;
    const result = await api.sessions
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
  prompt: (text: string) => Promise<void | PromptFailedError>;
  abort: () => Promise<void | AbortFailedError>;
};

export function sessionTitleQueryKey(sessionId: string) {
  return ["session-title", sessionId] as const;
}

export function useDraftAgentSession(
  onAccepted: (sessionId: string) => void,
): UseDraftAgentSessionResult {
  const api = useApi();
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
    onAcceptedRef.current(sessionId);
  }, [sessionId, hasMessages]);

  async function prompt(text: string) {
    setLocalError(undefined);
    setTitle(text);
    if (sessionIdRef.current === undefined) {
      const created = await api.sessions.create().catch(
        (e) =>
          new PromptFailedError({
            reason: e instanceof Error ? e.message : String(e),
            cause: e,
          }),
      );
      if (created instanceof Error) {
        setLocalError(created.message);
        setTitle(undefined);
        return created;
      }
      sessionIdRef.current = created.sessionId;
      setSessionId(created.sessionId);
    }

    queryClient.setQueryData(sessionTitleQueryKey(sessionIdRef.current), text);
    const result = await api.sessions
      .prompt({ sessionId: sessionIdRef.current, text })
      .then(() => undefined)
      .catch(
        (e) =>
          new PromptFailedError({
            reason: e instanceof Error ? e.message : String(e),
            cause: e,
          }),
      );
    if (result instanceof PromptFailedError) {
      setLocalError(result.message);
      setTitle(undefined);
      return result;
    }
    await queryClient.invalidateQueries({
      queryKey: ["sessions"],
      refetchType: "all",
    });
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
