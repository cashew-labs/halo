import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { WorkspacePanes, panes, type PaneState } from "./WorkspacePanes.js";

const PanesContext = createContext<WorkspacePanes | undefined>(undefined);
export const TabRouteContext = createContext<string | undefined>(undefined);
export const TabVisibilityContext = createContext(true);

export function WorkspacePanesProvider({
  initialPath,
  children,
}: {
  initialPath: string;
  children: ReactNode;
}) {
  const [workspace] = useState(() => new WorkspacePanes(initialPath));
  useEffect(() => {
    window.addEventListener("popstate", workspace.followHistory);
    window.addEventListener("hashchange", workspace.followHistory);
    return () => {
      window.removeEventListener("popstate", workspace.followHistory);
      window.removeEventListener("hashchange", workspace.followHistory);
    };
  }, [workspace]);
  return <PanesContext value={workspace}>{children}</PanesContext>;
}
export function useWorkspacePanes() {
  return useContext(PanesContext)!;
}
export function usePaneState(): PaneState {
  const workspace = useWorkspacePanes();
  return useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
}
export function usePaneLocation(): [
  string,
  (path: string, options?: { replace?: boolean }) => void,
] {
  const workspace = useWorkspacePanes();
  const state = usePaneState();
  const tabId = useContext(TabRouteContext);
  const pane =
    tabId === undefined
      ? workspace.activePane()
      : panes(state.root).find((candidate) =>
          candidate.tabs.some((item) => item.id === tabId),
        )!;
  const tab = pane.tabs.find(
    (item) => item.id === (tabId ?? pane.activeTabId),
  )!;
  return [
    tab.path,
    (path, options) =>
      workspace.open({
        path,
        tabId,
        history: options?.replace ? "replace" : "push",
      }),
  ];
}
