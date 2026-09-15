import { useEffect, useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button as AriaButton } from "react-aria-components";
import * as errore from "errore";
import {
  backgroundColor,
  Button,
  colors,
  Flex,
  focusRing,
  iconSizeValues,
  Menu,
  MenuItem,
  MenuTrigger,
  radius,
  Text,
} from "maui";
import { style, useStyles } from "purse-styles";
import { Check, Menu as MenuIcon } from "maui/icons";
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
  const brand = brands.google;
  const menuLabel = `${label} actions`;
  const canConnect = sessionId !== undefined;

  return (
    <section
      aria-label={`${label} connection`}
      data-session-id={sessionId}
      data-integration={part.request.integration}
      data-testid="executor-connection-card"
    >
      <Flex
        column
        gap={1}
        p={6}
        shadow="subtle"
        radius="lg"
        style={{
          width: "100%",
          maxWidth: "400px",
          backgroundColor: backgroundColor.element,
        }}
      >
        <Flex row gap={4} alignItems="center">
          {display === undefined ? (
            <BrandLogo brand="google" size="xl" />
          ) : (
            <LogoImage src={display.icon} size="xl" />
          )}
          <Text size="md" fontWeight={600} style={{ flex: 1, minWidth: 0 }}>
            {label}
          </Text>
          {status === "idle" ? (
            <Button
              variant="primary"
              variantColor={brand.buttonColor}
              style={{ color: brand.buttonForeground, flexShrink: 0 }}
              disabled={!canConnect}
              onClick={() => connect.mutate()}
            >
              Connect
            </Button>
          ) : (
            <Flex row gap={2} alignItems="center" style={{ flexShrink: 0 }}>
              <ConnectionStatusLabel status={status} />
              <ConnectionOverflowMenu
                label={menuLabel}
                status={status}
                canConnect={canConnect}
                cancelPending={cancel.isPending}
                onCancel={() => cancel.mutate()}
                onConnect={() => connect.mutate()}
                onDisconnect={() => {
                  queryClient.setQueryData(statusKey, idleConnectionState);
                }}
              />
            </Flex>
          )}
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
  if (status === "connected") {
    return (
      <Flex
        row
        gap={1}
        alignItems="center"
        style={{ color: colors.green[11] }}
      >
        <Check size="sm" />
        <Text size="md" style={{ color: colors.green[11] }}>
          Connected
        </Text>
      </Flex>
    );
  }
  if (status === "starting") {
    return <Text size="md">Starting connection...</Text>;
  }
  if (status === "connecting") {
    return <Text size="md">Finish connecting in your browser</Text>;
  }
  if (status === "cancelled") {
    return <Text size="md">Cancelled</Text>;
  }
  return <Text size="md">Expired</Text>;
}

function ConnectionOverflowMenu({
  label,
  status,
  canConnect,
  cancelPending,
  onCancel,
  onConnect,
  onDisconnect,
}: {
  label: string;
  status: Exclude<ConnectionState["status"], "idle">;
  canConnect: boolean;
  cancelPending: boolean;
  onCancel(): void;
  onConnect(): void;
  onDisconnect(): void;
}) {
  const buttonClassName = useStyles(menuButton);
  const items = overflowItems({
    status,
    canConnect,
    cancelPending,
    onCancel,
    onConnect,
    onDisconnect,
  });

  return (
    <MenuTrigger placement="bottom end">
      <AriaButton aria-label={label} className={buttonClassName}>
        <MenuIcon size="sm" />
      </AriaButton>
      <Menu aria-label={label}>{items}</Menu>
    </MenuTrigger>
  );
}

function overflowItems({
  status,
  canConnect,
  cancelPending,
  onCancel,
  onConnect,
  onDisconnect,
}: {
  status: Exclude<ConnectionState["status"], "idle">;
  canConnect: boolean;
  cancelPending: boolean;
  onCancel(): void;
  onConnect(): void;
  onDisconnect(): void;
}): ReactNode {
  if (status === "connecting") {
    return (
      <MenuItem onAction={onCancel} isDisabled={cancelPending}>
        Cancel
      </MenuItem>
    );
  }
  if (status === "connected") {
    return (
      <>
        <MenuItem onAction={onConnect} isDisabled={!canConnect}>
          Connect different account
        </MenuItem>
        <MenuItem onAction={onDisconnect}>Disconnect</MenuItem>
      </>
    );
  }
  if (status === "cancelled") {
    return (
      <MenuItem onAction={onConnect} isDisabled={!canConnect}>
        Connect
      </MenuItem>
    );
  }
  if (status === "expired") {
    return (
      <MenuItem onAction={onConnect} isDisabled={!canConnect}>
        Connect
      </MenuItem>
    );
  }
  return undefined;
}

const menuButton = style(
  focusRing(),
  radius.sm,
  {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: "24px",
    width: "24px",
    padding: 0,
    border: 0,
    backgroundColor: "transparent",
    color: colors.gray[11],
    cursor: "pointer",
    flexShrink: 0,
    "&:hover": { backgroundColor: colors.gray[4] },
    "&[data-disabled]": { opacity: 0.5 },
  },
);
