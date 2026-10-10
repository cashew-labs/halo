import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  background,
  Button,
  colors,
  Flex,
  iconSizeValues,
  radius,
  shadow,
  Text,
} from "maui";
import { style, useStyles } from "purse-styles";
import { Check } from "maui/icons";
import {
  connectionRequestLabel,
  googleIntegrationDisplay,
} from "@get-halo/client";
import { useHost } from "../../HostProvider.js";
import { brands, LogoImage } from "../../BrandLogo.tsx";
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
import type { SessionViewPart } from "./sessionView.ts";

type ExecutorConnectionPart = Extract<
  SessionViewPart,
  { kind: "executorConnection" }
>;

const card = style(background.element, radius.lg, shadow.subtle, {
  width: "100%",
  maxWidth: "400px",
});
const brandButton = style({
  flexShrink: 0,
});

export function ExecutorConnectionCard({
  sessionId,
  part,
}: {
  sessionId: string | undefined;
  part: ExecutorConnectionPart;
}) {
  const cardClassName = useStyles(card);
  const brandButtonClassName = useStyles(brandButton);
  const host = useHost();
  const queryClient = useQueryClient();
  const statusKey = useMemo(
    () => connectionStateQueryKey(sessionId, part.request),
    [part.request, sessionId],
  );
  const cardKey = useMemo(
    () => connectionCardQueryKey(sessionId, part.request),
    [part.request, sessionId],
  );
  const shared = useQuery<ConnectionState>({
    queryKey: statusKey,
    queryFn: async () => idleConnectionState,
    initialData: idleConnectionState,
    enabled: false,
  }).data;
  const startedCard = useQuery<StartedConnectionCard>({
    queryKey: cardKey,
    queryFn: async () => ({}), // coverage-exempt: disabled query; initialData only
    initialData: {},
    enabled: false,
  }).data;
  const connection = connectionStateForCard(
    shared,
    startedCard.cardId,
    part.id,
  );
  const wasConnected = shared.status === "connected";
  const connect = useMutation({
    mutationFn: async () => {
      // SAFETY: the button is disabled until sessionId is a string.
      const activeSessionId = sessionId as string;
      const started = await host.connectIntegration({
        sessionId: activeSessionId,
        request: part.request,
      });
      if (started instanceof Error) throw started;
      if (started.status === "connected") return started;
      const connecting: ConnectionState = {
        status: "connecting",
        connectionId: started.connectionId,
        expiresAt: started.expiresAt,
        wasConnected: started.wasConnected,
      };
      queryClient.setQueryData(statusKey, connecting);
      return started;
    },
    onMutate: () => {
      const previousCard =
        queryClient.getQueryData<StartedConnectionCard>(cardKey) ?? {};
      const starting: ConnectionState = {
        status: "starting",
        wasConnected,
      };
      queryClient.setQueryData(statusKey, starting);
      queryClient.setQueryData<StartedConnectionCard>(cardKey, {
        cardId: part.id,
      });
      return { previousCard };
    },
    onSuccess: (started) => {
      if (started.status !== "connected") return;
      queryClient.setQueryData<ConnectionState>(statusKey, {
        status: "connected",
      });
    },
    onError: (error, _input, context) => {
      queryClient.setQueryData<ConnectionState>(
        statusKey,
        connectionStateAfterFailedStart,
      );
      queryClient.setQueryData<StartedConnectionCard>(
        cardKey,
        context?.previousCard ?? {},
      );
      console.warn("Connection failed:", error);
    },
  });
  const cancel = useMutation({
    mutationFn: async () => {
      if (sessionId === undefined || connection.status !== "connecting") return;
      const cancelled = await host.cancelIntegration({
        sessionId,
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

  const status = connection.status;
  const display = googleIntegrationDisplay(part.request.integration);
  const label = connectionRequestLabel(part.request);
  const brand = brands.google;
  const canConnect = sessionId !== undefined;
  const brandButtonProps =
    display === undefined
      ? {}
      : {
          variantColor: brand.buttonColor,
          style: { color: brand.buttonForeground },
        };

  return (
    <section
      aria-label={`${label} connection`}
      data-session-id={sessionId}
      data-integration={part.request.integration}
      data-testid="executor-connection-card"
      className={cardClassName}
    >
      <Flex column gap={1} p={6}>
        <Flex row gap={4} alignItems="center">
          {display !== undefined && <LogoImage src={display.icon} size="xl" />}
          <Text size="md" fontWeight={600} style={{ flex: 1, minWidth: 0 }}>
            {label}
          </Text>
          <Flex row gap={3} alignItems="center" style={{ flexShrink: 0 }}>
            {status === "idle" ? undefined : (
              <ConnectionStatusLabel status={status} />
            )}
            {status === "starting" ? undefined : status === "connecting" ? (
              <Button
                variant="quiet"
                isDisabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel
              </Button>
            ) : status === "connected" ? (
              <Button
                variant="default"
                isDisabled={!canConnect}
                onClick={() => connect.mutate()}
              >
                Add account
              </Button>
            ) : (
              <Button
                variant="primary"
                {...brandButtonProps}
                className={brandButtonClassName}
                isDisabled={!canConnect}
                onClick={() => connect.mutate()}
              >
                {status === "idle" ? "Connect" : "Connect again"}
              </Button>
            )}
          </Flex>
        </Flex>
        {display === undefined ? undefined : (
          <Flex row gap={4} alignItems="start">
            <span
              aria-hidden="true"
              style={{ width: iconSizeValues.xl, flexShrink: 0 }}
            />
            <Text size="md" color="lowContrast">
              {display.description}
            </Text>
          </Flex>
        )}
      </Flex>
    </section>
  );
}

function ConnectionStatusLabel({
  status,
}: {
  status: Exclude<ConnectionState["status"], "idle">;
}) {
  const color = connectionStatusColor[status];
  if (status === "connected") {
    return (
      <Flex row gap={1} alignItems="center" style={{ color }}>
        <Check size="sm" />
        <Text size="sm" fontWeight={500} style={{ color }}>
          Connected
        </Text>
      </Flex>
    );
  }
  return (
    <Text size="sm" fontWeight={500} style={{ color }}>
      {connectionStatusCopy[status]}
    </Text>
  );
}

const connectionStatusColor = {
  starting: colors.blue[11],
  connecting: colors.blue[11],
  connected: colors.green[11],
  cancelled: colors.orange[11],
  expired: colors.red[11],
  failed: colors.red[11],
} as const;

const connectionStatusCopy = {
  starting: "Starting connection",
  connecting: "Opened in your browser",
  cancelled: "Cancelled",
  expired: "Expired",
  failed: "Connection failed",
} as const;
