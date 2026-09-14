import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as errore from "errore";
import { background, Button, Flex, radius, shadow, Spacer, Text } from "maui";
import { style, useStyles } from "purse-styles";
import { connectionRequestLabel } from "@get-halo/shared/ConnectionRequest";
import { BrandLogo, brands } from "../../BrandLogo.tsx";
import { useApi } from "../../api/ApiProvider.tsx";
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
class OpenAuthorizationError extends errore.createTaggedError({
  name: "OpenAuthorizationError",
  message: "Halo could not open the authorization page",
}) {}

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
  const api = useApi();
  const cardClassName = useStyles(card);
  const brandButtonClassName = useStyles(brandButton);
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
      const started = await api.sessions.startConnection({
        sessionId: activeSessionId,
        request: part.request,
      });
      if (started.status === "connected") return started;
      const connecting: ConnectionState = {
        status: "connecting",
        connectionId: started.connectionId,
        expiresAt: Date.now() + started.expiresInMs,
        wasConnected,
      };
      queryClient.setQueryData(statusKey, connecting);
      const opened = await desktopApi
        .openExternal({
          type: "openExternal",
          url: started.authorizationUrl,
        })
        .catch((cause) => new OpenAuthorizationError({ cause }));
      if (opened instanceof Error) {
        const cancelled = await api.sessions
          .cancelConnection({
            sessionId: activeSessionId,
            connectionId: started.connectionId,
          })
          .then(() => undefined)
          .catch((cause) => new OpenAuthorizationError({ cause }));
        if (cancelled instanceof Error) {
          console.warn("OAuth cleanup failed:", cancelled);
        }
        throw opened;
      }
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
      await api.sessions.cancelConnection({
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
            disabled={
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
