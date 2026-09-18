import { useCallback, useEffect, useSyncExternalStore } from "react";
import * as errore from "errore";
import type { SessionSnapshot } from "@get-halo/client";
import { useWorkspaceQuery } from "../../api/ApiProvider.js";

class SessionReadStateError extends errore.createTaggedError({
  name: "SessionReadStateError",
  message: "Could not access the session read state",
}) {}

const readStateChanged = "halo:session-read-state";

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(readStateChanged, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(readStateChanged, onChange);
  };
}

export function useSessionReadState(sessionId: string) {
  const workspace = useWorkspaceQuery().data;
  const key = JSON.stringify([
    "halo:session-read-state",
    workspace?.workspaceRoot,
    sessionId,
  ]);
  const getSnapshot = useCallback(() => {
    const stored = errore.try({
      try: () => window.localStorage.getItem(key),
      catch: (cause) => new SessionReadStateError({ cause }),
    });
    if (stored instanceof Error) {
      console.warn(stored);
      return undefined;
    }
    return stored ?? undefined;
  }, [key]);
  const seenResultId = useSyncExternalStore(subscribe, getSnapshot);
  const markSeen = useCallback(
    (resultId: string) => {
      const saved = errore.try({
        try: () => window.localStorage.setItem(key, resultId),
        catch: (cause) => new SessionReadStateError({ cause }),
      });
      if (saved instanceof Error) {
        console.warn(saved);
        return;
      }
      window.dispatchEvent(new Event(readStateChanged));
    },
    [key],
  );
  return { seenResultId, markSeen };
}

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
  sessionId,
  state,
}: {
  sessionId: string;
  state: SessionSnapshot;
}) {
  const { seenResultId, markSeen } = useSessionReadState(sessionId);
  const isViewing = useSyncExternalStore(subscribeToFocus, isViewingWindow);
  const resultId =
    state.lastRun?.id ??
    state.entries
      .filter(
        (entry) =>
          entry.type === "message" && entry.message.role === "assistant",
      )
      .at(-1)?.id;
  const isRunning = state.activeRun !== undefined;
  useEffect(() => {
    if (
      !isViewing ||
      isRunning ||
      resultId === undefined ||
      resultId === seenResultId
    )
      return;
    markSeen(resultId);
  }, [isViewing, isRunning, resultId, seenResultId, markSeen]);
}
