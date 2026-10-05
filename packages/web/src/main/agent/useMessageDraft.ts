import { useCallback, useState } from "react";
import * as errore from "errore";
import { useAuthenticatedUserId } from "../../Authentication.js";
import { useWorkspaceQuery } from "../../api/ApiProvider.js";

class MessageDraftStorageError extends errore.createTaggedError({
  name: "MessageDraftStorageError",
  message: "Could not $operation message draft",
}) {}

export function useMessageDraftKey({
  kind,
  messageId,
}: {
  kind: "session" | "draft";
  messageId: string;
}) {
  const userId = useAuthenticatedUserId();
  const workspaceRoot = useWorkspaceQuery().data?.workspaceRoot;
  if (workspaceRoot === undefined) return undefined;
  return JSON.stringify([
    "halo:message-draft",
    userId,
    workspaceRoot,
    kind,
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

export function clearMessageDraft(key: string | undefined) {
  if (key === undefined) return;
  const removed = errore.try({
    try: () => window.localStorage.removeItem(key),
    catch: (cause) =>
      new MessageDraftStorageError({ operation: "clear", cause }),
  });
  if (removed instanceof Error) console.warn(removed);
}

export function useMessageDraft(key: string | undefined) {
  const [draft, setDraft] = useState(() => readMessageDraft(key));
  const updateDraft = useCallback(
    (text: string) => {
      setDraft(text);
      if (text === "") {
        clearMessageDraft(key);
        return;
      }
      if (key === undefined) return;
      const saved = errore.try({
        try: () => window.localStorage.setItem(key, text),
        catch: (cause) =>
          new MessageDraftStorageError({ operation: "save", cause }),
      });
      if (saved instanceof Error) console.warn(saved);
    },
    [key],
  );
  return [draft, updateDraft] as const;
}
