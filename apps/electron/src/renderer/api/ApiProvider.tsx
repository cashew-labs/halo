import { useMutation, useQuery } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import type { HaloClient } from "@get-halo/shared/contract";
import type { WorkspaceInfo } from "@get-halo/shared/rpc";
import { useHost } from "@get-halo/web/HostProvider";
import { LoadingPage } from "../LoadingPage.tsx";
import { ConnectionPage } from "../ConnectionPage.tsx";
import { electronHost } from "../ElectronHost.js";
import { IncompatibleServerError } from "./connectHaloRpc.js";

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
    // Dev starts Electron and the workspace server independently; discovery may arrive later.
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

  return <ApiContext value={connected}>{children}</ApiContext>;
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
    queryFn: async () => await electronHost.getAppInfo(),
    refetchInterval: 5_000,
  });
}

export function useInstallAppUpdateMutation() {
  return useMutation({
    mutationFn: async () => await electronHost.installAppUpdate(),
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
