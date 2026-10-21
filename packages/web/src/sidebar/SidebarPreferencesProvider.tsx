import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { SidebarPreferences } from "./SidebarPreferences.js";

const SidebarPreferencesContext = createContext<SidebarPreferences>(undefined!);

export function SidebarPreferencesProvider({
  userId,
  workspaceRoot,
  children,
}: {
  userId: string;
  workspaceRoot: string;
  children: ReactNode;
}) {
  // A new user or workspace reads its own stored preferences.
  const preferences = useMemo(
    () => new SidebarPreferences({ userId, workspaceRoot }),
    [userId, workspaceRoot],
  );
  return (
    <SidebarPreferencesContext value={preferences}>
      {children}
    </SidebarPreferencesContext>
  );
}

export function useSidebarPreferences() {
  return useContext(SidebarPreferencesContext);
}

export function useSidebarPreferenceState() {
  const preferences = useSidebarPreferences();
  return useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
}

export function useFavoriteIds() {
  return useSidebarPreferenceState().favoriteIds;
}
