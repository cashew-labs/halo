import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import type { HaloClient } from "@get-halo/shared/contract";
import type { WorkspaceInfo } from "@get-halo/shared/rpc";
import type { HaloRpcConnection } from "../../shared/HaloRpcConnection.js";
import { LoadingPage } from "../LoadingPage.tsx";
import { ConnectionPage } from "../ConnectionPage.tsx";
import { hostApi } from "./host.js";
import {
  IncompatibleServerError,
  type HaloRpcConnectionError,
} from "./connectHaloRpc.js";

type ApiContextValue = {
  api: HaloClient;
  connection: HaloRpcConnection;
  queryClient: QueryClient;
};

export type ConnectedHaloApi = {
  api: HaloClient;
  connection: HaloRpcConnection;
};

const ApiContext = createContext<ApiContextValue>(undefined!);
const haloApiQueryKey = ["halo-api"] as const;
const workspaceQueryKey = ["workspace"] as const;

export function ApiProvider({
  createApi,
  children,
}: {
  createApi: (options: {
    onDisconnect: (error: HaloRpcConnectionError) => void;
  }) => Promise<ConnectedHaloApi | Error | undefined>;
  children: ReactNode;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Infinity,
          },
          mutations: {
            retry: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ResolveApi createApi={createApi}>{children}</ResolveApi>
    </QueryClientProvider>
  );
}

function ResolveApi({
  createApi,
  children,
}: {
  createApi: (options: {
    onDisconnect: (error: HaloRpcConnectionError) => void;
  }) => Promise<ConnectedHaloApi | Error | undefined>;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [disconnected, setDisconnected] = useState(false);
  const disconnect = useCallback((error: Error) => {
    console.warn("Halo disconnected from its server:", error);
    setDisconnected(true);
  }, []);
  const apiQuery = useQuery({
    queryKey: haloApiQueryKey,
    // Dev starts Electron and the workspace server independently; discovery may arrive later.
    refetchInterval: (query) =>
      query.state.data?.api === undefined ? 1_000 : false,
    queryFn: async () => {
      const api = await createApi({ onDisconnect: disconnect });
      return { api };
    },
  });

  if (apiQuery.isPending) return <LoadingPage />;
  if (apiQuery.isError) {
    console.warn("Halo API initialization failed:", apiQuery.error);
    return <ConnectionPage status="disconnected" />;
  }
  if (disconnected) return <ConnectionPage status="disconnected" />;
  const connected = apiQuery.data.api;
  if (connected === undefined) return <ConnectionPage status="waiting" />;
  if (connected instanceof IncompatibleServerError) {
    return <ConnectionPage status="incompatible" error={connected} />;
  }
  if (connected instanceof Error) {
    return <ConnectionPage status="disconnected" />;
  }

  return (
    <ApiContext value={{ ...connected, queryClient }}>{children}</ApiContext>
  );
}

export function useApi(): HaloClient {
  return useContext(ApiContext).api;
}

export function useApiConnection() {
  return useContext(ApiContext).connection;
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

  return useQuery({
    queryKey: ["sessions", workspaceRoot],
    queryFn: async () => await api.sessions.list(),
    enabled: workspaceRoot !== undefined,
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

export function useAppInfoQuery() {
  return useQuery({
    queryKey: ["app-info"],
    queryFn: async () => await hostApi.getAppInfo(),
    refetchInterval: 5_000,
  });
}

export function useInstallAppUpdateMutation() {
  return useMutation({
    mutationFn: async () => await hostApi.installAppUpdate(),
  });
}

export function useExtensionsQuery(workspace: WorkspaceInfo | undefined) {
  const api = useApi();
  const workspaceRoot = workspace?.workspaceRoot;

  return useQuery({
    queryKey: ["extensions", workspaceRoot],
    queryFn: async () => await api.extensions.list(),
    enabled: workspaceRoot !== undefined,
  });
}
