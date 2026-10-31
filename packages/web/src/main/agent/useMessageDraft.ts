import { useCallback, useEffect, useState } from "react";
import * as errore from "errore";
import { useAuthenticatedUserId } from "../../Authentication.js";
import { useWorkspaceQuery } from "../../api/ApiProvider.js";

const draftChangedEvent = "halo:message-draft-changed";

class MessageDraftStorageError extends errore.createTaggedError({
  name: "MessageDraftStorageError",
  message: "Could not $operation message draft",
}) {}

export function useMessageDraftKey({
  kind,
  messageId,
}: {
  kind: "thread" | "draft";
  messageId: string;
}) {
  const userId = useAuthenticatedUserId();
  const workspaceRoot = useWorkspaceQuery().data?.workspaceRoot;
  if (workspaceRoot === undefined) return undefined;
  return JSON.stringify([
    "halo:message-draft",
    userId,
    workspaceRoot,
    // Retain the storage key for existing thread drafts.
    kind === "thread" ? "session" : kind,
    messageId,
  ]);
}

function readMessageDraft(key: string | undefined) {
  if (key === undefined) return "";
  const stored = errore.try({
    try: () => window.localStorage.getItem(key),
    catch: (cause) =>
      new MessageDraftStorageError({ operation: "read", cause }),
  });
  if (stored instanceof Error) {
    console.warn(stored);
    return "";
  }
  return stored ?? "";
}

// Dropping the saved copy during submission must not clear the visible composer.
export function clearMessageDraft(key: string | undefined) {
  if (key === undefined) return;
  const removed = errore.try({
    try: () => window.localStorage.removeItem(key),
    catch: (cause) =>
      new MessageDraftStorageError({ operation: "clear", cause }),
  });
  if (removed instanceof Error) {
    console.warn(removed);
    return removed;
  }
}

export function useMessageDraft(key: string | undefined) {
  const [draft, setDraft] = useState(() => readMessageDraft(key));
  useEffect(() => {
    const refresh = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === key)
        setDraft(readMessageDraft(key));
    };
    window.addEventListener(draftChangedEvent, refresh);
    return () => window.removeEventListener(draftChangedEvent, refresh);
  }, [key]);
  const updateDraft = useCallback(
    (text: string) => {
      setDraft(text);
      if (key === undefined) return;
      if (text === "") {
        if (clearMessageDraft(key) instanceof Error) return;
        window.dispatchEvent(
          new CustomEvent(draftChangedEvent, { detail: key }),
        );
        return;
      }
      const saved = errore.try({
        try: () => window.localStorage.setItem(key, text),
        catch: (cause) =>
          new MessageDraftStorageError({ operation: "save", cause }),
      });
      if (saved instanceof Error) {
        console.warn(saved);
        return;
      }
      window.dispatchEvent(new CustomEvent(draftChangedEvent, { detail: key }));
    },
    [key],
  );
  return [draft, updateDraft] as const;
}
