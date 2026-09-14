import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as errore from "errore";
import { backgroundColor, Button, Flex, Spacer, Text } from "maui";
import { connectionRequestLabel } from "@get-halo/shared/ConnectionRequest";
import { googleIntegrationDisplay } from "@get-halo/shared/GoogleIntegrationDisplay";
import { BrandLogo, brands, LogoImage } from "../../BrandLogo.tsx";
import { desktopApi } from "../../api/electron.ts";
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
class ConnectIntegrationError extends errore.createTaggedError({
  name: "ConnectIntegrationError",
  message: "Halo could not start the connection",
}) {}

export function ExecutorConnectionCard({
  sessionId,
  part,
}: {
  sessionId: string | undefined;
  part: ExecutorConnectionPart;
}) {
  const queryClient = useQueryClient();
  const statusKey = useMemo(
    () => connectionStateQueryKey(part.request),
    [part.request],
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
      const started = await desktopApi
        .connectIntegration({
          sessionId: activeSessionId,
          request: part.request,
        })
        .catch((cause) => new ConnectIntegrationError({ cause }));
      if (started instanceof Error) throw started;
      if (started.status === "connected") return started;
      const connecting: ConnectionState = {
        status: "connecting",
        connectionId: started.connectionId,
        expiresAt: Date.now() + started.expiresInMs,
        wasConnected,
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
      await desktopApi.cancelIntegration({
        sessionId,
        connectionId: connection.connectionId,
      });
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

  useEffect(() => {
    if (connection.status !== "connecting") return;
    const connectionId = connection.connectionId;
    const timeout = window.setTimeout(
      () => {
        queryClient.setQueryData<ConnectionState>(statusKey, (current) => {
          if (current?.status !== "connecting") return current;
          if (current.connectionId !== connectionId) return current;
          return current.wasConnected
            ? { status: "connected" }
            : { status: "expired" };
        });
      },
      Math.max(0, connection.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [connection, queryClient, statusKey]);

  const status = connection.status;
  const display = googleIntegrationDisplay(part.request.integration);
  const label = connectionRequestLabel(part.request);
  const statusText = connectionStatusText(status);
  const brand = brands.google;

  return (
    <section
      aria-label={`${label} connection`}
      data-session-id={sessionId}
      data-integration={part.request.integration}
      data-testid="executor-connection-card"
    >
      <Flex
        column
        gap={6}
        p={6}
        shadow="subtle"
        radius="lg"
        style={{
          width: "100%",
          maxWidth: "400px",
          backgroundColor: backgroundColor.element,
        }}
      >
        <Flex row gap={4} alignItems="start">
          {display === undefined ? (
            <BrandLogo brand="google" size="xl" />
          ) : (
            <LogoImage src={display.icon} size="xl" />
          )}
          <Flex column gap={1}>
            <Text size="md" fontWeight={600}>
              {label}
            </Text>
            {display === undefined ? undefined : (
              <Text size="sm" color="lowContrast">
                {display.description}
              </Text>
            )}
            {statusText === undefined ? undefined : (
              <Text size="sm" color="lowContrast">
                {statusText}
              </Text>
            )}
          </Flex>
          <Spacer />
          <Button
            variant="primary"
            variantColor={brand.buttonColor}
            style={{ color: brand.buttonForeground, flexShrink: 0 }}
            disabled={
              sessionId === undefined ||
              status === "starting" ||
              status === "connecting"
            }
            onClick={() => connect.mutate()}
          >
            {connectionButtonLabel(status)}
          </Button>
          {status === "connecting" ? (
            <Button
              variant="quiet"
              disabled={cancel.isPending}
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

function connectionStatusText(status: ConnectionState["status"]) {
  if (status === "connected") return "Connected";
  if (status === "expired") return "Authorization expired";
  if (status === "cancelled") return "Authorization cancelled";
  if (status === "connecting") return "Finish connecting in your browser";
  if (status === "starting") return "Preparing authorization";
  return undefined;
}

function connectionButtonLabel(status: ConnectionState["status"]) {
  if (status === "connected") return "Connect again";
  if (status === "expired") return "Expired - connect again";
  if (status === "cancelled") return "Try again";
  if (status === "connecting") return "Connecting";
  if (status === "starting") return "Starting";
  return "Connect";
}
