import { ExtensionsProvider } from "./ExtensionsProvider.js";
import { reconnectStream } from "./reconnectStream.js";
import { useQuery, useQueryClient, skipToken } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useEffect,
  useContext,
  useState,
  type ReactNode,
} from "react";
import {
  type HaloClient,
  type WorkspaceInfo,
  type SessionSummary,
  IncompatibleServerError,
} from "@get-halo/client";
import { useHost } from "../HostProvider.js";
import { LoadingPage } from "../LoadingPage.tsx";
import { ConnectionPage } from "../ConnectionPage.tsx";

const ApiContext = createContext<HaloClient>(undefined!);
const haloApiQueryKey = ["halo-api"] as const;
const workspaceQueryKey = ["workspace"] as const;

export function ApiProvider({ children }: { children: ReactNode }) {
  const host = useHost();
  const [disconnected, setDisconnected] = useState(false);
  const disconnect = useCallback((error: Error) => {
    console.warn("Halo disconnected from its server:", error);
    setDisconnected(true);
  }, []);
  const apiQuery = useQuery({
    queryKey: haloApiQueryKey,
    // Development starts clients and the workspace server independently; discovery may arrive later.
    refetchInterval: (query) =>
      query.state.data === undefined ? 1_000 : false,
    queryFn: async () => {
      return await host.connectHalo({ onDisconnect: disconnect });
    },
  });

  if (apiQuery.isPending) return <LoadingPage />;
  if (apiQuery.isError) {
    console.warn("Halo API initialization failed:", apiQuery.error);
    return <ConnectionPage status="disconnected" />;
  }
  if (disconnected) return <ConnectionPage status="disconnected" />;
  const connected = apiQuery.data;
  if (connected === undefined) return <ConnectionPage status="waiting" />;
  if (connected instanceof IncompatibleServerError) {
    return <ConnectionPage status="incompatible" error={connected} />;
  }
  if (connected instanceof Error) {
    return <ConnectionPage status="disconnected" />;
  }

  return (
    <ApiContext value={connected}>
      <ExtensionsProvider api={connected}>{children}</ExtensionsProvider>
    </ApiContext>
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
  const api = useApi();
  const workspaceRoot = workspace?.workspaceRoot;

  const queryClient = useQueryClient();
  useEffect(() => {
    if (workspaceRoot === undefined) return;
    const controller = new AbortController();
    reconnectStream({
      name: "Session summaries",
      signal: controller.signal,
      open: async () =>
        await api.sessions.watchSummaries(undefined, {
          signal: controller.signal,
        }),
      onItem: (item) => {
        queryClient.setQueryData<SessionSummary[]>(
          ["sessions", workspaceRoot],
          (current = []) => {
            if (item.type === "snapshot") return item.sessions;
            const sessions = [
              ...current.filter(
                (session) => session.sessionId !== item.session.sessionId,
              ),
              item.session,
            ];
            // oxlint-disable-next-line unicorn/no-array-sort -- This new array is owned here; the web package targets ES2022.
            return sessions.sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            );
          },
        );
      },
    });
    return () => controller.abort();
  }, [api, queryClient, workspaceRoot]);

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
  const workspaceRoot = workspace?.workspaceRoot;

  return useQuery({
    queryKey: workspacePathsQueryKey(workspaceRoot),
    queryFn: async () => await api.workspace.listPaths(),
    enabled: workspaceRoot !== undefined,
  });
}

export function useWorkspaceFileQuery(path: string) {
  const api = useApi();
  return useQuery({
    queryKey: ["workspace-file", path],
    queryFn: async () => await api.workspace.readFile({ path }),
  });
}
