import {
  createContext,
  useContext,
  useState,
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
  const [preferences] = useState(
    () => new SidebarPreferences({ userId, workspaceRoot }),
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
