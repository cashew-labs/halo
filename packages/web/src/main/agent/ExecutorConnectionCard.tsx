import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { background, Button, Flex, radius, shadow, Spacer, Text } from "maui";
import { style, useStyles } from "purse-styles";
import { connectionRequestLabel } from "@get-halo/client";
import { useHost } from "../../HostProvider.js";
import { BrandLogo, brands } from "../../BrandLogo.tsx";
import {
  connectionStateQueryKey,
  idleConnectionState,
  type ConnectionState,
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
  const connection = useQuery<ConnectionState>({
    queryKey: statusKey,
    queryFn: async () => idleConnectionState,
    initialData: idleConnectionState,
    enabled: false,
  }).data;
  const wasConnected = connection.status === "connected";
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
      const starting: ConnectionState = {
        status: "starting",
        wasConnected,
      };
      queryClient.setQueryData(statusKey, starting);
    },
    onSuccess: (started) => {
      if (started.status !== "connected") return;
      queryClient.setQueryData<ConnectionState>(statusKey, {
        status: "connected",
      });
    },
    onError: (error) => {
      queryClient.setQueryData<ConnectionState>(statusKey, (current) => {
        if (
          (current?.status === "starting" ||
            current?.status === "connecting") &&
          current.wasConnected
        ) {
          return { status: "connected" };
        }
        return idleConnectionState;
      });
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
      queryClient.setQueryData<ConnectionState>(statusKey, (current) => {
        if (current?.status !== "connecting") return current;
        return current.wasConnected
          ? { status: "connected" }
          : { status: "cancelled" };
      });
    },
    onError: (error) => {
      console.warn("Connection cancellation failed:", error);
    },
  });

  const status = connection.status;
  const label = connectionRequestLabel(part.request);
  const brand = brands.google;

  return (
    <section
      aria-label={`${label} connection`}
      data-session-id={sessionId}
      data-integration={part.request.integration}
      data-testid="executor-connection-card"
      className={cardClassName}
    >
      <Flex column gap={6} p={6}>
        <Flex row gap={4} alignItems="start">
          <BrandLogo brand="google" size="xl" />
          <Flex column gap={1}>
            <Text size="md" fontWeight={600}>
              {label}
            </Text>
            <Text size="sm" color="lowContrast">
              {status === "connected"
                ? "Connected"
                : status === "expired"
                  ? "Authorization expired"
                  : status === "cancelled"
                    ? "Authorization cancelled"
                    : status === "connecting"
                      ? "Finish connecting in your browser"
                      : status === "starting"
                        ? "Preparing authorization"
                        : "Connect your account so the agent can continue"}
            </Text>
          </Flex>
          <Spacer />
          <Button
            variant="primary"
            variantColor={brand.buttonColor}
            style={{ color: brand.buttonForeground }}
            className={brandButtonClassName}
            isDisabled={
              sessionId === undefined ||
              status === "starting" ||
              status === "connecting"
            }
            onClick={() => connect.mutate()}
          >
            {status === "connected"
              ? "Connect again"
              : status === "expired"
                ? "Expired - connect again"
                : status === "cancelled"
                  ? "Try again"
                  : status === "connecting"
                    ? "Connecting"
                    : status === "starting"
                      ? "Starting"
                      : "Connect"}
          </Button>
          {status === "connecting" ? (
            <Button
              variant="quiet"
              isDisabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          ) : undefined}
        </Flex>
      </Flex>
    </section>
  );
}
