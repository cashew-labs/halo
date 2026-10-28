import type { ReactNode } from "react";
import {
  Avatar,
  background,
  borderColor,
  Button,
  colors,
  controlSize,
  Flex,
  iconSizeValues,
  LogoIcon,
  Menu,
  MenuItem,
  MenuTrigger,
  radius,
  shadow,
  spacing,
  Text,
} from "maui";
import { style, useStyles } from "purse-styles";
import {
  Check,
  DotsHorizontal,
  NewWindow,
  Trash,
  WarningTriangle,
} from "maui/icons";
import {
  connectionRequestLabel,
  connectionRequestName,
  integrationDisplay,
  type ConnectionRequest,
  type IntegrationConnection,
} from "@get-halo/client";
import { brands } from "../../BrandLogo.tsx";
import type { ConnectionState } from "./ConnectionState.ts";

const card = style(background.element, radius.lg, shadow.subtle, {
  width: "100%",
  maxWidth: "400px",
  overflow: "hidden",
});
const brandButton = style({
  flexShrink: 0,
});
const accountList = style(background.element, radius.md, {
  listStyle: "none",
  margin: 0,
  padding: 0,
  width: "100%",
  minWidth: 0,
  border: `1px solid ${borderColor.outline}`,
  overflow: "hidden",
  "& > li + li": {
    borderTop: `1px solid ${borderColor.outline}`,
  },
});

type CardAction = { onPress(): void; isDisabled?: boolean };

// Shared rendering for the live card and isolated flow-preview fixtures.
export function ConnectionCard({
  threadId,
  request,
  status,
  accounts,
  accountsStatus,
  refreshingAccounts = false,
  browserOpened = true,
  error,
  connect,
  addAccount,
  cancel,
  reopen,
  retryAccounts,
  disconnectAccount,
  manageAccountAccess,
}: {
  threadId?: string;
  request: ConnectionRequest;
  status: ConnectionState["status"];
  accounts: IntegrationConnection[];
  accountsStatus: "pending" | "error" | "success";
  refreshingAccounts?: boolean;
  browserOpened?: boolean;
  error?: ReactNode;
  connect: CardAction;
  addAccount: CardAction;
  cancel: CardAction;
  reopen: CardAction;
  retryAccounts: CardAction;
  disconnectAccount?: (account: IntegrationConnection) => void;
  manageAccountAccess?: (account: IntegrationConnection) => void;
}) {
  const cardClassName = useStyles(card);
  const brandButtonClassName = useStyles(brandButton);
  const accountListClassName = useStyles(accountList);
  const updatingAccounts =
    status === "connected" &&
    (refreshingAccounts || accountsStatus === "pending");
  const repairName = connectionRequestName(request);
  const needsRepair = repairName !== undefined && status !== "connected";
  const repairAccount = accounts.find((account) => account.name === repairName);
  const active = status === "starting" || status === "connecting";
  const showEmptyAccounts =
    accountsStatus === "success" &&
    accounts.length === 0 &&
    !active &&
    !updatingAccounts;
  const display = integrationDisplay(request.integration);
  const label = connectionRequestLabel(request);
  const brand = brands.google;
  const brandButtonProps =
    display !== undefined && request.integration.startsWith("google_")
      ? {
          variantColor: brand.buttonColor,
          style: { color: brand.buttonForeground },
        }
      : {};

  return (
    <section
      aria-label={`${label} connection`}
      data-thread-id={threadId}
      data-integration={request.integration}
      data-testid="executor-connection-card"
      className={cardClassName}
    >
      <Flex column gap={1} p={6}>
        <Flex row gap={4} alignItems="center">
          {display !== undefined && <LogoIcon src={display.icon} size="xl" />}
          <Text size="md" fontWeight={600} style={{ flex: 1, minWidth: 0 }}>
            {label}
          </Text>
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
      <Flex
        row
        gap={4}
        p={6}
        alignItems="center"
        background="app"
        style={{
          borderTop: `1px solid ${borderColor.outline}`,
          flexWrap: "wrap",
        }}
      >
        {accounts.length > 0 && (
          <ul aria-label="Accounts" className={accountListClassName}>
            {accounts.map((account) => (
              <li key={account.address}>
                <Flex row gap={4} alignItems="center" px={4} py={3}>
                  <Avatar
                    name={account.accountLabel ?? account.name}
                    size="sm"
                  />
                  {needsRepair && account.name === repairName ? (
                    <WarningTriangle
                      size="sm"
                      role="img"
                      aria-hidden={false}
                      aria-label="Reconnection required"
                      style={{ color: colors.orange[11], flexShrink: 0 }}
                    />
                  ) : undefined}
                  <Text
                    size="sm"
                    fontWeight={500}
                    style={{ overflowWrap: "anywhere", flex: 1, minWidth: 0 }}
                  >
                    {account.accountLabel ?? account.name}
                  </Text>
                  {(disconnectAccount !== undefined ||
                    manageAccountAccess !== undefined) && (
                    <MenuTrigger placement="bottom end">
                      <Button
                        variant="quiet"
                        aria-label={`Actions for ${account.accountLabel ?? account.name}`}
                        isDisabled={active || updatingAccounts}
                      >
                        <DotsHorizontal size="md" />
                      </Button>
                      <Menu
                        aria-label={`Account actions for ${account.accountLabel ?? account.name}`}
                      >
                        {manageAccountAccess !== undefined && (
                          <MenuItem
                            id="manage"
                            textValue="Manage repository access"
                            onAction={() => manageAccountAccess(account)}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: spacing.value(3),
                            }}
                          >
                            <NewWindow size="sm" /> Manage repository access
                          </MenuItem>
                        )}
                        {disconnectAccount !== undefined && (
                          <MenuItem
                            id="disconnect"
                            textValue="Disconnect"
                            onAction={() => disconnectAccount(account)}
                            style={{
                              color: colors.red[11],
                              display: "flex",
                              alignItems: "center",
                              gap: spacing.value(3),
                            }}
                          >
                            <Trash size="sm" /> Disconnect
                          </MenuItem>
                        )}
                      </Menu>
                    </MenuTrigger>
                  )}
                </Flex>
              </li>
            ))}
          </ul>
        )}
        {showEmptyAccounts && (
          <Text size="sm" color="lowContrast" style={{ flex: "1 1 auto" }}>
            No accounts connected
          </Text>
        )}
        {(accountsStatus === "pending" || updatingAccounts) && (
          <Text
            size="sm"
            color="lowContrast"
            role="status"
            style={{ flex: "1 1 auto" }}
          >
            {updatingAccounts ? "Updating accounts…" : "Loading accounts…"}
          </Text>
        )}
        {accountsStatus === "error" && (
          <Text size="sm" role="alert" style={{ flex: "1 1 auto" }}>
            Couldn't load connected accounts.
          </Text>
        )}
        {error !== undefined && (
          <Text size="sm" role="alert" style={{ width: "100%" }}>
            {error}
          </Text>
        )}
        <Flex
          row
          gap={3}
          alignItems="center"
          justifyContent="end"
          style={{
            minHeight: controlSize.height,
            marginLeft: "auto",
            maxWidth: "100%",
            flexWrap: "wrap",
            flexShrink: 0,
          }}
        >
          {status !== "connecting" &&
          status !== "idle" &&
          (status !== "connected" ||
            accounts.length === 0 ||
            updatingAccounts) ? (
            <ConnectionStatusLabel status={status} />
          ) : undefined}
          {accountsStatus === "error" && (
            <Button variant="quiet" {...retryAccounts}>
              Reload accounts
            </Button>
          )}
          {status === "starting" || updatingAccounts ? undefined : status ===
            "connecting" ? (
            <Button variant="quiet" {...cancel}>
              Cancel
            </Button>
          ) : needsRepair ? (
            <Button
              variant="primary"
              {...brandButtonProps}
              className={brandButtonClassName}
              {...connect}
            >
              Reconnect {repairAccount?.accountLabel ?? repairName}
            </Button>
          ) : status === "connected" || accounts.length > 0 ? (
            <Button
              variant="primary"
              {...brandButtonProps}
              className={brandButtonClassName}
              {...addAccount}
            >
              Add account
            </Button>
          ) : (
            <Button
              variant="primary"
              {...brandButtonProps}
              className={brandButtonClassName}
              {...connect}
            >
              Connect
            </Button>
          )}
          {status === "connecting" && (
            <Button variant="quiet" variantColor="blue" {...reopen}>
              {browserOpened ? "Opened in your browser" : "Open in browser"}
            </Button>
          )}
        </Flex>
      </Flex>
    </section>
  );
}

function ConnectionStatusLabel({
  status,
}: {
  status: Exclude<ConnectionState["status"], "idle" | "connecting">;
}) {
  const color = connectionStatusColor[status];
  if (status === "connected") {
    return (
      <Flex row gap={1} alignItems="center" style={{ color }}>
        <Check size="sm" />
        <Text
          size="xs"
          fontWeight={500}
          role="status"
          style={{ color, textBox: "trim-both cap alphabetic" }}
        >
          Connected
        </Text>
      </Flex>
    );
  }
  return (
    <Text
      size="xs"
      fontWeight={500}
      role="status"
      style={{ color, textBox: "trim-both cap alphabetic" }}
    >
      {connectionStatusCopy[status]}
    </Text>
  );
}

const connectionStatusColor = {
  starting: colors.blue[11],
  connected: colors.green[11],
  cancelled: colors.orange[11],
  expired: colors.red[11],
  failed: colors.red[11],
} as const;

const connectionStatusCopy = {
  starting: "Starting connection",
  cancelled: "Cancelled",
  expired: "Expired",
  failed: "Connection failed",
} as const;
