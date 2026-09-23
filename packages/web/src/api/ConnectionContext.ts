import { createContext, useContext, useSyncExternalStore } from "react";
import type { ConnectionService } from "./ConnectionService.js";

export const ConnectionContext = createContext<ConnectionService>(undefined!);
export function useConnection() {
  const service = useContext(ConnectionContext);
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  return { service, state };
}
