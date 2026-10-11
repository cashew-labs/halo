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
  SessionSummary,
} from "@get-halo/client";
import { useWorkspaceQuery } from "./ApiProvider.js";
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
};
const empty: WorkspaceState = {
  extensions: { data: undefined, error: undefined },
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
        await api.server.watch(
          { includeAutomations: false, includeLegacyState: false },
          { signal: controller.signal },
        ),
      onItem: (item) => {
        if (
          item.type === "hotkeys" ||
          item.type === "files" ||
          item.type === "automations"
        )
          return;
        if (item.type === "sessions") {
          const update = item.update;
          if (update.type === "snapshot") {
            service.ready(api);
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
