import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { SidebarPreferences } from "./SidebarPreferences.js";

import { useConnection } from "../api/ConnectionContext.js";
import { useApi } from "../api/ApiProvider.js";
import { useDatabaseQuery } from "../database/useDatabaseQuery.js";
import { useWorkspaceDataSynced } from "../database/WorkspaceDataProvider.js";

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
  const api = useApi();
  const { state: connection } = useConnection();
  const synced = useWorkspaceDataSynced();
  const favorites = useDatabaseQuery({
    collection: "favorites",
    orderBy: { position: "asc" },
  })!;
  // A new user or workspace reads its own stored layout.
  const preferences = useMemo(
    () =>
      new SidebarPreferences({
        userId,
        workspaceRoot,
        favorites: {
          add: async (favoriteIds) => await api.favorites.add({ favoriteIds }),
          toggle: (favoriteId) => {
            void api.favorites.toggle({ favoriteId }).catch(console.error);
          },
          updateFiles: (source, destination) => {
            void api.favorites
              .updateFiles({ source, destination })
              .catch(console.error);
          },
        },
      }),
    [api, userId, workspaceRoot],
  );
  useEffect(() => {
    if (connection.status === "connected")
      void preferences.importFavorites().catch(console.error);
  }, [preferences, connection.status]);
  // An unsynced replica reports no favorites. Keep the last list until its
  // pull lands so the sidebar does not blank out on every reconnect.
  useEffect(() => {
    if (synced || favorites.length > 0)
      preferences.setFavoriteIds(favorites.map((item) => item.id));
  }, [preferences, favorites, synced]);
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
