import { FileSaveErrorsProvider } from "../main/FileSaveErrors.js";
import {
  useAuthenticatedUserId,
  useReauthenticate,
} from "../Authentication.js";
import { WorkspaceUpdatesProvider } from "./WorkspaceUpdatesProvider.js";
import { WorkspaceDataProvider } from "../database/WorkspaceDataProvider.js";
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
  IncompatibleServerError,
  type HaloClient,
  type WorkspaceInfo,
  type ThreadSummary,
} from "@get-halo/client";
import { useHost } from "../HostProvider.js";
import { ConnectionService } from "./ConnectionService.js";
import { ConnectionContext, useConnection } from "./ConnectionContext.js";
import {
  ConnectionPage,
  OfflinePage,
  WorkspaceUpdate,
} from "../ConnectionPage.js";
import { LoadingPage } from "../LoadingPage.js";
import { SignInPage } from "../SignInPage.js";
import { ChatOutboxProvider } from "../main/agent/ChatOutboxProvider.js";

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
        <OpeningWorkspacePage />
      ) : (
        <ApiContext value={state.api}>
          <WorkspaceUpdatesProvider
            key={state.workspace?.workspaceRoot}
            api={state.api}
          >
            <ChatOutboxProvider api={state.api}>
              <WorkspaceDataProvider api={state.api}>
                <FileSaveErrorsProvider>{children}</FileSaveErrorsProvider>
              </WorkspaceDataProvider>
            </ChatOutboxProvider>
          </WorkspaceUpdatesProvider>
        </ApiContext>
      )}
    </ConnectionContext>
  );
}

/**
 * Before the workspace opens, only an attempt in progress shows the loading
 * screen. States that wait on the user or on an update get their own page.
 */
function OpeningWorkspacePage() {
  const { service, state } = useConnection();
  const reauthenticate = useReauthenticate();
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string>();
  if (state.status === "authentication") {
    const signIn = async () => {
      setSigningIn(true);
      setSignInError(undefined);
      const result = await reauthenticate();
      setSigningIn(false);
      if (result instanceof Error) {
        console.warn(result);
        setSignInError("Couldn't sign in with Google. Try again.");
        return;
      }
      if (result) service.resumeAfterSignIn();
    };
    return (
      <SignInPage
        error={signInError}
        signingIn={signingIn}
        onSignIn={() => void signIn()}
      />
    );
  }
  if (state.error instanceof IncompatibleServerError)
    return (
      <ConnectionPage
        error={state.error}
        onRetry={service.retry}
        workspaceUpdateAvailable={
          state.update !== undefined &&
          state.update.version !== state.update.targetVersion
        }
      />
    );
  if (state.status === "offline") return <OfflinePage />;
  return (
    <LoadingPage
      progressLabel={
        state.status === "upgrading"
          ? "Upgrading your cloud workspace"
          : "Opening your cloud workspace"
      }
    >
      {state.status !== "upgrading" &&
        state.update !== undefined &&
        state.update.version !== state.update.targetVersion && (
          <WorkspaceUpdate />
        )}
    </LoadingPage>
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

export function useThreadsQuery(workspace: WorkspaceInfo | undefined) {
  const workspaceRoot = workspace?.workspaceRoot;

  return useQuery<ThreadSummary[]>({
    queryKey: ["threads", workspaceRoot],
    queryFn: skipToken,
  });
}
