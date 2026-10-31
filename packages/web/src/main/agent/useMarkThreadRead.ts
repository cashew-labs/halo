import { useContext, useEffect, useSyncExternalStore } from "react";
import * as errore from "errore";
import {
  isThreadUnread,
  agentUserMessage,
  type ThreadSnapshot,
  type ThreadSummary,
} from "@get-halo/client";
import { useApi } from "../../api/ApiProvider.js";
import { TabVisibilityContext } from "../../panes/WorkspacePanesProvider.js";

class MarkThreadReadError extends errore.createTaggedError({
  name: "MarkThreadReadError",
  message: "Could not mark the thread as read",
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

export function useMarkThreadRead({
  thread,
  state,
}: {
  thread: ThreadSummary | undefined;
  state: ThreadSnapshot;
}) {
  const api = useApi();
  const isViewing = useSyncExternalStore(subscribeToFocus, isViewingWindow);
  const isTabVisible = useContext(TabVisibilityContext);
  const threadId = thread?.sessionId;
  const latestResultId = thread?.latestResultId;
  const isRunning = thread?.isRunning;
  const isAgent = state.agentId !== undefined;
  const isUnread = thread !== undefined && isThreadUnread(thread);
  const lastRunId = state.lastRun?.id;
  const lastAssistantEntryId = state.entries
    .filter(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    )
    .at(-1)?.id;
  const lastSentEntryId = isAgent
    ? state.entries
        .filter((entry) => agentUserMessage(entry) !== undefined)
        .at(-1)?.id
    : undefined;

  useEffect(() => {
    if (
      !isViewing ||
      !isTabVisible ||
      threadId === undefined ||
      (!isAgent && (isRunning || state.activeRun !== undefined)) ||
      latestResultId === undefined ||
      !isUnread ||
      (isAgent
        ? lastSentEntryId !== latestResultId
        : lastRunId !== latestResultId &&
          lastAssistantEntryId !== latestResultId)
    )
      return;
    const readInput = { sessionId: threadId, observedResultId: latestResultId };
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    async function markRead() {
      const result = await api.thread
        .markRead(readInput)
        .catch((cause) => new MarkThreadReadError({ cause }));
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
    threadId,
    isRunning,
    isAgent,
    lastSentEntryId,
    isUnread,
    latestResultId,
    state.activeRun,
    lastRunId,
    lastAssistantEntryId,
  ]);
}
