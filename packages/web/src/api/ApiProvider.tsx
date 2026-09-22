import { useAuthenticatedUserId } from "../Authentication.js";
import { WorkspaceUpdatesProvider } from "./WorkspaceUpdatesProvider.js";
import { useQuery, skipToken, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  type HaloClient,
  type WorkspaceInfo,
  type SessionSummary,
} from "@get-halo/client";
import { useHost } from "../HostProvider.js";
import { ConnectionService } from "./ConnectionService.js";
import { ConnectionContext, useConnection } from "./ConnectionContext.js";
import { ConnectionStatus } from "../ConnectionStatus.js";

const ApiContext = createContext<HaloClient>(undefined!);
const workspaceQueryKey = ["workspace"] as const;

export function ApiProvider({ children }: { children: ReactNode }) {
  const host = useHost();
  const queryClient = useQueryClient();
  const userId = useAuthenticatedUserId();
  const [service] = useState(() => new ConnectionService({ host }));
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  useEffect(() => {
    const previousUser = queryClient.getQueryData<string>(["connection-user"]);
    if (previousUser !== undefined && previousUser !== userId)
      queryClient.clear();
    queryClient.setQueryData(["connection-user"], userId);
    const unsubscribe = service.changes.subscribe((next) => {
      if (next.status !== "synchronizing" || next.workspace === undefined)
        return;
      const previous =
        queryClient.getQueryData<WorkspaceInfo>(workspaceQueryKey);
      if (
        previous !== undefined &&
        previous.workspaceRoot !== next.workspace.workspaceRoot
      ) {
        queryClient.clear();
        queryClient.setQueryData(["connection-user"], userId);
      }
      queryClient.setQueryData(workspaceQueryKey, next.workspace);
    });
    service.start();
    return () => {
      unsubscribe();
      service.dispose();
    };
  }, [service, queryClient, userId]);
  return (
    <ConnectionContext value={service}>
      {state.api === undefined ? (
        <main
          style={{
            height: "100dvh",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: 24,
          }}
        >
          <p>Waiting for your server. Halo will connect automatically.</p>
          <ConnectionStatus />
        </main>
      ) : (
        <ApiContext value={state.api}>
          <WorkspaceUpdatesProvider
            key={state.workspace?.workspaceRoot}
            api={state.api}
          >
            {children}
          </WorkspaceUpdatesProvider>
        </ApiContext>
      )}
    </ConnectionContext>
  );
}

export function useApi(): HaloClient {
  return useContext(ApiContext);
}

export function useWorkspaceQuery() {
  const api = useApi();
  return useQuery({
    queryKey: workspaceQueryKey,
    queryFn: async () => await api.workspace.get(),
  });
}

export function useSessionsQuery(workspace: WorkspaceInfo | undefined) {
  const workspaceRoot = workspace?.workspaceRoot;

  return useQuery<SessionSummary[]>({
    queryKey: ["sessions", workspaceRoot],
    queryFn: skipToken,
  });
}

export function workspacePathsQueryKey(workspaceRoot: string | undefined) {
  return ["workspace-paths", workspaceRoot] as const;
}

export function useWorkspacePathsQuery(workspace: WorkspaceInfo | undefined) {
  const api = useApi();
  const { state } = useConnection();
  const workspaceRoot = workspace?.workspaceRoot;

  return useQuery({
    queryKey: workspacePathsQueryKey(workspaceRoot),
    queryFn: async () => await api.workspace.listPaths(),
    enabled: workspaceRoot !== undefined && state.status === "connected",
  });
}

export function useWorkspaceFileQuery(path: string) {
  const api = useApi();
  const { state } = useConnection();
  return useQuery({
    queryKey: ["workspace-file", path],
    enabled: state.status === "connected",
    queryFn: async () => await api.workspace.readFile({ path }),
  });
}
