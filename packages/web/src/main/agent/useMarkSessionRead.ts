import { useContext, useEffect, useRef, useSyncExternalStore } from "react";
import * as errore from "errore";
import { isThreadUnread, type SessionSummary } from "@get-halo/client";
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

export function useMarkSessionRead(session: SessionSummary | undefined) {
  const api = useApi();
  const isViewing = useSyncExternalStore(subscribeToFocus, isViewingWindow);
  const isTabVisible = useContext(TabVisibilityContext);
  const observed = useRef<
    | {
        sessionId: string;
        readCursorId: string;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    if (!isViewing || !isTabVisible) {
      observed.current = undefined;
      return;
    }
    if (
      session === undefined ||
      session.isRunning ||
      session.latestResultId === undefined ||
      (observed.current?.sessionId === session.sessionId &&
        observed.current.readCursorId === session.latestResultId)
    )
      return;
    observed.current = {
      sessionId: session.sessionId,
      readCursorId: session.latestResultId,
    };
    if (!isThreadUnread(session)) return;
    void api.sessions
      .markRead({ sessionId: session.sessionId })
      .catch((cause) => {
        observed.current = undefined;
        console.warn(new MarkSessionReadError({ cause }));
      });
  }, [api, isTabVisible, isViewing, session]);
}
