import { useConnection } from "./ConnectionContext.js";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as errore from "errore";
import type {
  ExtensionSummary,
  HaloClient,
  Hotkey,
  SessionSummary,
} from "@get-halo/client";
import { useWorkspaceQuery, workspacePathsQueryKey } from "./ApiProvider.js";
import { reconnectStream } from "./reconnectStream.js";

class WorkspaceUpdatesError extends errore.createTaggedError({
  name: "WorkspaceUpdatesError",
  message: "$reason",
}) {}

type WorkspaceState = {
  extensions: {
    data: ExtensionSummary[] | undefined;
    error: Error | undefined;
  };
  hotkeys: Hotkey[];
};
const empty: WorkspaceState = {
  extensions: { data: undefined, error: undefined },
  hotkeys: [],
};
const WorkspaceUpdatesContext = createContext<WorkspaceState>(empty);

export function WorkspaceUpdatesProvider({
  api,
  children,
}: {
  api: HaloClient;
  children: ReactNode;
}) {
  const { service, state: connection } = useConnection();
  const enabled =
    connection.status === "synchronizing" || connection.status === "connected";
  const workspaceRoot = useWorkspaceQuery().data?.workspaceRoot;
  const queryClient = useQueryClient();
  const [state, setState] = useState<
    WorkspaceState & { workspaceRoot: string | undefined }
  >({
    ...empty,
    workspaceRoot,
  });
  useEffect(() => {
    if (workspaceRoot === undefined || !enabled) return;
    const controller = new AbortController();
    reconnectStream({
      name: "Workspace updates",
      signal: controller.signal,
      open: async () =>
        await api.server.watch(undefined, { signal: controller.signal }),
      // Filesystem events do not have a snapshot; refetch after every reconnect.

      onItem: async (item) => {
        if (item.type === "files") {
          await queryClient.invalidateQueries({
            queryKey: workspacePathsQueryKey(workspaceRoot),
          });
          return;
        }
        if (item.type === "sessions") {
          const update = item.update;
          if (update.type === "snapshot") {
            service.ready(api);
            void queryClient
              .invalidateQueries({
                queryKey: workspacePathsQueryKey(workspaceRoot),
              })
              .catch(console.error);
          }
          queryClient.setQueryData<SessionSummary[]>(
            ["sessions", workspaceRoot],
            (current = []) => {
              if (update.type === "snapshot") return update.sessions;
              const sessions = [
                ...current.filter(
                  (session) => session.sessionId !== update.session.sessionId,
                ),
                update.session,
              ];
              // oxlint-disable-next-line unicorn/no-array-sort -- This new array is owned here; the web package targets ES2022.
              return sessions.sort((left, right) =>
                right.updatedAt.localeCompare(left.updatedAt),
              );
            },
          );
          return;
        }
        setState((current) => {
          const previous =
            current.workspaceRoot === workspaceRoot ? current : empty;
          if (item.type === "hotkeys")
            return { ...previous, workspaceRoot, hotkeys: item.hotkeys };
          if (item.type === "extensions")
            return {
              ...previous,
              workspaceRoot,
              extensions: { data: item.extensions, error: undefined },
            };
          return {
            ...previous,
            workspaceRoot,
            extensions: {
              ...previous.extensions,
              error: new WorkspaceUpdatesError({ reason: item.message }),
            },
          };
        });
      },
      onError: (error) => {
        service.fail(api, error);
        setState((current) => {
          const previous =
            current.workspaceRoot === workspaceRoot ? current : empty;
          return {
            ...previous,
            workspaceRoot,
            extensions: { ...previous.extensions, error },
          };
        });
      },
    });
    return () => controller.abort();
  }, [api, queryClient, workspaceRoot, service, enabled]);
  return (
    <WorkspaceUpdatesContext
      value={state.workspaceRoot === workspaceRoot ? state : empty}
    >
      {children}
    </WorkspaceUpdatesContext>
  );
}

export function useExtensions() {
  return useContext(WorkspaceUpdatesContext).extensions;
}

export function useHotkeys() {
  return useContext(WorkspaceUpdatesContext).hotkeys;
}
