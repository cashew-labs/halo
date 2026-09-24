import { useContext, useEffect, useSyncExternalStore } from "react";
import * as errore from "errore";
import {
  isThreadUnread,
  type SessionSnapshot,
  type SessionSummary,
} from "@get-halo/client";
import { useApi } from "../../api/ApiProvider.js";
import { TabVisibilityContext } from "../../panes/WorkspacePanesProvider.js";

class MarkSessionReadError extends errore.createTaggedError({
  name: "MarkSessionReadError",
  message: "Could not mark the session as read",
}) {}

function subscribeToFocus(onChange: () => void) {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

function isViewingWindow() {
  return document.visibilityState === "visible" && document.hasFocus();
}

export function useMarkSessionRead({
  session,
  state,
}: {
  session: SessionSummary | undefined;
  state: SessionSnapshot;
}) {
  const api = useApi();
  const isViewing = useSyncExternalStore(subscribeToFocus, isViewingWindow);
  const isTabVisible = useContext(TabVisibilityContext);
  const sessionId = session?.sessionId;
  const latestResultId = session?.latestResultId;
  const isRunning = session?.isRunning;
  const isUnread = session !== undefined && isThreadUnread(session);
  const lastRunId = state.lastRun?.id;
  const lastAssistantEntryId = state.entries
    .filter(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    )
    .at(-1)?.id;

  useEffect(() => {
    if (
      !isViewing ||
      !isTabVisible ||
      sessionId === undefined ||
      isRunning ||
      state.activeRun !== undefined ||
      latestResultId === undefined ||
      !isUnread ||
      (lastRunId !== latestResultId && lastAssistantEntryId !== latestResultId)
    )
      return;
    const readInput = { sessionId, observedResultId: latestResultId };
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    async function markRead() {
      const result = await api.sessions
        .markRead(readInput)
        .catch((cause) => new MarkSessionReadError({ cause }));
      if (!(result instanceof Error)) return;
      console.warn(result);
      if (cancelled) return;
      retryTimer = setTimeout(() => {
        markRead().catch(console.warn);
      }, 2_000);
    }

    markRead().catch(console.warn);
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [
    api,
    isTabVisible,
    isViewing,
    sessionId,
    isRunning,
    isUnread,
    latestResultId,
    state.activeRun,
    lastRunId,
    lastAssistantEntryId,
  ]);
}
