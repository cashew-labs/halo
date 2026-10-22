import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { HaloClient } from "@get-halo/client";
import { useRestartWarning } from "../../confirmRestart.js";
import { ChatOutbox } from "./ChatOutbox.js";

const ChatOutboxContext = createContext<ChatOutbox>(undefined!);

/** Owns the workspace's chat outbox, so sends outlive their chat panes. */
export function ChatOutboxProvider({
  api,
  children,
}: {
  api: HaloClient;
  children: ReactNode;
}) {
  const [outbox] = useState(() => new ChatOutbox({ api }));
  useEffect(() => outbox.setApi(api), [outbox, api]);
  useEffect(() => () => outbox.close(), [outbox]);
  const unsent = useSyncExternalStore(
    useCallback((onChange) => outbox.state.subscribe(onChange), [outbox]),
    () =>
      // A returned message waits for its thread's composer to take it back.
      outbox.state.latestValue.some((message) => message.state !== "sent"),
  );
  useRestartWarning(unsent);
  return <ChatOutboxContext value={outbox}>{children}</ChatOutboxContext>;
}

export function useChatOutbox() {
  return useContext(ChatOutboxContext);
}
