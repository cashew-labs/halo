import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { colors } from "maui";
import * as errore from "errore";
import {
  connectionRequestName,
  type ConnectionRequest,
} from "@get-halo/client";
import { useHost } from "../../HostProvider.js";
import { useApi } from "../../api/ApiProvider.js";
import { ConnectionCard } from "./ConnectionCard.js";
import {
  connectionCardQueryKey,
  connectionStateAfterCancel,
  connectionStateAfterFailedStart,
  connectionStateForCard,
  connectionStateQueryKey,
  idleConnectionState,
  type ConnectionState,
  type StartedConnectionCard,
} from "./ConnectionState.ts";
import type { ThreadViewPart } from "./threadView.ts";

type ExecutorConnectionPart = Extract<
  ThreadViewPart,
  { kind: "executorConnection" }
>;

class ConnectionPopupBlockedError extends errore.createTaggedError({
  name: "ConnectionPopupBlockedError",
  message: "Allow pop-ups to open connection setup.",
}) {}

export function ExecutorConnectionCard({
  threadId,
  part,
}: {
  threadId: string | undefined;
  part: ExecutorConnectionPart;
}) {
  const host = useHost();
  const api = useApi();
  const queryClient = useQueryClient();
  const [request, setRequest] = useState(part.request);
  const accounts = useQuery({
    queryKey: ["integrationConnections"],
    queryFn: async ({ signal }) =>
      await api.workspace.integrationConnections(undefined, { signal }),
    // Connections can change through the agent or another client.
    staleTime: 0,
    refetchInterval: 5000,
  });
  const integrationAccounts = (accounts.data ?? []).filter(
    (account) => account.integration === part.request.integration,
  );
  const statusKey = useMemo(
    () => connectionStateQueryKey(threadId, request),
    [request, threadId],
  );
  const cardKey = useMemo(
    () => connectionCardQueryKey(threadId, request),
    [request, threadId],
  );
  const shared = useQuery<ConnectionState>({
    queryKey: statusKey,
    queryFn: async () => idleConnectionState,
    initialData: idleConnectionState,
    enabled: false,
  }).data;
  const { mutate: refreshAccounts, isPending: refreshingAccounts } =
    useMutation({
      mutationFn: async () =>
        await queryClient.invalidateQueries({
          queryKey: ["integrationConnections"],
        }),
      onError: (error) => console.warn("Account refresh failed:", error),
    });
  useEffect(() => {
    if (shared.status !== "connected") return;
    refreshAccounts();
  }, [shared.status, refreshAccounts]);
  const startedCard = useQuery<StartedConnectionCard>({
    queryKey: cardKey,
    queryFn: async () => ({}), // coverage-exempt: disabled query; initialData only
    initialData: {},
    enabled: false,
  }).data;
  const browserOpened = startedCard.browserOpened ?? true;
  const connection = connectionStateForCard(
    shared,
    startedCard.cardId,
    part.id,
  );
  const connect = useMutation({
    mutationFn: async (submittedRequest: ConnectionRequest) => {
      // SAFETY: the button is disabled until threadId is a string.
      const activeThreadId = threadId as string;
      const started = await host.connectIntegration({
        threadId: activeThreadId,
        request: submittedRequest,
      });
      if (started instanceof Error) throw started;
      if (started.status === "connected") return started;
      const connecting: ConnectionState = {
        status: "connecting",
        connectionId: started.connectionId,
        expiresAt: started.expiresAt,
        wasConnected: started.wasConnected,
        authorizationUrl: started.authorizationUrl,
      };
      queryClient.setQueryData(
        connectionStateQueryKey(threadId, submittedRequest),
        connecting,
      );
      return started;
    },
    onMutate: (submittedRequest) => {
      cancel.reset();
      reopen.reset();
      // Add account starts an unnamed attempt, never another named repair.
      setRequest(submittedRequest);
      const attemptStatusKey = connectionStateQueryKey(
        threadId,
        submittedRequest,
      );
      const attemptCardKey = connectionCardQueryKey(threadId, submittedRequest);
      const wasConnected =
        connectionRequestName(submittedRequest) === undefined &&
        queryClient.getQueryData<ConnectionState>(attemptStatusKey)?.status ===
          "connected";
      const previousCard =
        queryClient.getQueryData<StartedConnectionCard>(attemptCardKey) ?? {};
      const starting: ConnectionState = { status: "starting", wasConnected };
      queryClient.setQueryData(attemptStatusKey, starting);
      queryClient.setQueryData<StartedConnectionCard>(attemptCardKey, {
        cardId: part.id,
      });
      return { previousCard };
    },
    onSuccess: (started, submittedRequest) => {
      queryClient.setQueryData<StartedConnectionCard>(
        connectionCardQueryKey(threadId, submittedRequest),
        (card) => ({ ...card, browserOpened: started.browserOpened ?? true }),
      );
      if (started.status !== "connected") return;
      queryClient.setQueryData<ConnectionState>(
        connectionStateQueryKey(threadId, submittedRequest),
        {
          status: "connected",
        },
      );
    },
    onError: (error, submittedRequest, context) => {
      queryClient.setQueryData<ConnectionState>(
        connectionStateQueryKey(threadId, submittedRequest),
        connectionStateAfterFailedStart,
      );
      queryClient.setQueryData<StartedConnectionCard>(
        connectionCardQueryKey(threadId, submittedRequest),
        context?.previousCard ?? {},
      );
      console.warn("Connection failed:", error);
    },
  });
  const cancel = useMutation({
    mutationFn: async () => {
      if (threadId === undefined || connection.status !== "connecting") return;
      const cancelled = await host.cancelIntegration({
        threadId,
        connectionId: connection.connectionId,
      });
      if (cancelled instanceof Error) throw cancelled;
      queryClient.setQueryData<ConnectionState>(
        statusKey,
        connectionStateAfterCancel,
      );
    },
    onError: (error) => {
      console.warn("Connection cancellation failed:", error);
    },
  });
  const reopen = useMutation({
    mutationFn: async (url: string) => {
      if (host.openExternalUrl === undefined) {
        // noopener makes window.open return null even for successful opens.
        const setupPage = window.open("about:blank", "_blank");
        if (setupPage === null) throw new ConnectionPopupBlockedError();
        // oxlint-disable-next-line unicorn/no-null -- Detach the new tab before navigating to the provider.
        setupPage.opener = null;
        setupPage.location.replace(url);
        return;
      }
      const opened = await host.openExternalUrl(url);
      if (opened instanceof Error) throw opened;
    },
    onSettled: (_data, error) => {
      queryClient.setQueryData<StartedConnectionCard>(cardKey, (card) => ({
        ...card,
        browserOpened: error === null,
      }));
      if (error !== null)
        console.warn("Could not reopen connection setup:", error);
    },
  });
  const startConnection = (submittedRequest: ConnectionRequest) => {
    const pending = queryClient.getQueryData<ConnectionState>(
      connectionStateQueryKey(threadId, submittedRequest),
    );
    if (pending?.status === "starting" || pending?.status === "connecting") {
      // Join the existing attempt instead of orphaning its setup and Cancel.
      setRequest(submittedRequest);
      return;
    }
    connect.mutate(submittedRequest);
  };
  const openSetup = () => {
    cancel.reset();
    if (
      connection.status === "connecting" &&
      connection.authorizationUrl !== undefined
    )
      reopen.mutate(connection.authorizationUrl);
  };

  return (
    <ConnectionCard
      threadId={threadId}
      request={request}
      status={connection.status}
      accounts={integrationAccounts}
      accountsStatus={accounts.status}
      refreshingAccounts={refreshingAccounts}
      browserOpened={browserOpened}
      error={
        connection.status === "connecting" ? (
          cancel.isError ? (
            "Couldn't cancel. Setup may still be active. Try Cancel again."
          ) : !browserOpened && connection.authorizationUrl !== undefined ? (
            <>
              Failed to open browser.{" "}
              <a
                href={connection.authorizationUrl}
                data-external-link="custom"
                style={{ color: colors.blue[11] }}
                onClick={(event) => {
                  event.preventDefault();
                  openSetup();
                }}
              >
                Open this link
              </a>{" "}
              in your browser to continue connecting.
            </>
          ) : undefined
        ) : connect.isError ? (
          "Couldn't start connection setup. Try connecting again."
        ) : undefined
      }
      connect={{
        onPress: () => startConnection(request),
        isDisabled: threadId === undefined,
      }}
      addAccount={{
        onPress: () =>
          startConnection({
            kind: "control-plane",
            integration: request.integration,
          }),
        isDisabled: threadId === undefined,
      }}
      cancel={{
        onPress: () => {
          reopen.reset();
          cancel.mutate();
        },
        isDisabled: cancel.isPending,
      }}
      reopen={{
        onPress: openSetup,
        isDisabled:
          connection.status !== "connecting" ||
          connection.authorizationUrl === undefined ||
          reopen.isPending,
      }}
      retryAccounts={{
        onPress: () => void accounts.refetch(),
        isDisabled: accounts.isFetching,
      }}
    />
  );
}
