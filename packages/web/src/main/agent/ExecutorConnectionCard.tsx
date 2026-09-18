import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button as AriaButton } from "react-aria-components";
import {
  background,
  Button,
  colors,
  Flex,
  focusRing,
  iconSizeValues,
  Menu,
  MenuItem,
  MenuTrigger,
  radius,
  shadow,
  Text,
} from "maui";
import { style, useStyles } from "purse-styles";
import { Check, DotsHorizontal } from "maui/icons";
import {
  connectionRequestLabel,
  googleIntegrationDisplay,
} from "@get-halo/client";
import { useHost } from "../../HostProvider.js";
import { brands, LogoImage } from "../../BrandLogo.tsx";
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
      className={cardClassName}
    >
      <Flex column gap={1} p={6}>
        <Flex row gap={4} alignItems="center">
          <LogoImage
            src={display === undefined ? brand.logoUrl : display.icon}
            size="xl"
          />
          <Text size="md" fontWeight={600} style={{ flex: 1, minWidth: 0 }}>
            {label}
          </Text>
          {status === "idle" ? (
            <Button
              variant="primary"
              variantColor={brand.buttonColor}
              style={{ color: brand.buttonForeground }}
              className={brandButtonClassName}
              disabled={!canConnect}
              onClick={() => connect.mutate()}
            >
              Connect
            </Button>
          ) : (
            <Flex row gap={2} alignItems="center" style={{ flexShrink: 0 }}>
              <ConnectionStatusLabel status={status} />
              {status === "starting" ? undefined : (
                <ConnectionOverflowMenu
                  label={menuLabel}
                  status={status}
                  canConnect={canConnect}
                  cancelPending={cancel.isPending}
                  onCancel={() => cancel.mutate()}
                  onConnect={() => connect.mutate()}
                />
              )}
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
} as const;

const connectionStatusCopy = {
  starting: "Starting connection",
  connecting: "Opened in your browser",
  cancelled: "Cancelled",
  expired: "Expired",
} as const;

function ConnectionOverflowMenu({
  label,
  status,
  canConnect,
  cancelPending,
  onCancel,
  onConnect,
}: {
  label: string;
  status: Exclude<ConnectionState["status"], "idle" | "starting">;
  canConnect: boolean;
  cancelPending: boolean;
  onCancel(): void;
  onConnect(): void;
}) {
  const buttonClassName = useStyles(menuButton);

  return (
    <MenuTrigger placement="bottom end">
      <AriaButton aria-label={label} className={buttonClassName}>
        <DotsHorizontal size="sm" />
      </AriaButton>
      <Menu aria-label={label}>
        {status === "connecting" ? (
          <MenuItem onAction={onCancel} isDisabled={cancelPending}>
            Cancel
          </MenuItem>
        ) : (
          <MenuItem onAction={onConnect} isDisabled={!canConnect}>
            {status === "connected" ? "Connect different account" : "Connect"}
          </MenuItem>
        )}
      </Menu>
    </MenuTrigger>
  );
}

const menuButton = style(focusRing(), radius.sm, {
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
});
