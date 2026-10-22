import { useMutation, useQuery } from "@tanstack/react-query";
import { background, Button, Code, Flex, radius, shadow, Text } from "maui";
import { Check, Close, Code as CodeIcon, Folder } from "maui/icons";
import { style, useStyles } from "purse-styles";
import type {
  DeviceFileAccess,
  DevicePermission,
  ToolApproval,
} from "@get-halo/client";
import { useApi } from "../../api/ApiProvider.tsx";
import { useHost } from "../../HostProvider.tsx";

const card = style(background.element, radius.lg, shadow.subtle, {
  width: "100%",
  maxWidth: "440px",
});

/**
 * Asks the person to let the agent use a folder or run commands on one of
 * their computers. Only Halo on that computer can allow it, because the
 * computer records the answer itself.
 */
export function DevicePermissionCard({
  sessionId,
  approval,
  permission,
}: {
  sessionId: string | undefined;
  approval: ToolApproval;
  permission: DevicePermission;
}) {
  const cardClassName = useStyles(card);
  const api = useApi();
  const host = useHost();
  const localDevice = useQuery({
    queryKey: ["local-device"],
    queryFn: async () => {
      const info = await host.device?.read();
      return info instanceof Error ? undefined : info;
    },
    enabled: host.device !== undefined,
    staleTime: Infinity,
  });
  const onThisComputer = localDevice.data?.id === permission.deviceId;
  const respond = useMutation({
    mutationFn: async (answer: DeviceFileAccess | "deny") => {
      // SAFETY: every action is disabled until sessionId is a string.
      const activeSessionId = sessionId as string;
      if (answer !== "deny") {
        const allowed = await host.device?.allow({
          request: permission.request,
          access: answer,
        });
        if (allowed instanceof Error) throw allowed;
      }
      await api.thread.respondToToolApproval({
        sessionId: activeSessionId,
        approvalId: approval.id,
        decision: answer === "deny" ? "deny" : "allow",
      });
    },
  });
  const copy = permissionCopy(permission);
  const pending = approval.status === "pending";
  const disabled = sessionId === undefined || respond.isPending;
  const { request } = permission;

  return (
    <section
      aria-label={copy.title}
      data-testid="device-permission-card"
      className={cardClassName}
    >
      <Flex column gap={4} p={6}>
        <Flex row gap={4}>
          {request.kind === "commands" ? (
            <CodeIcon size="lg" />
          ) : (
            <Folder size="lg" />
          )}
          <Flex column gap={1}>
            <Text size="md" fontWeight={600}>
              {copy.title}
            </Text>
            <Text size="sm" color="lowContrast">
              {copy.description}
            </Text>
          </Flex>
        </Flex>
        {request.kind === "commands" && <Code>{request.command}</Code>}
        {respond.error != undefined && (
          <Text size="sm" role="alert">
            {respond.error.message}
          </Text>
        )}
        {pending ? (
          <Flex column gap={3}>
            {!onThisComputer && (
              <Text size="sm" color="lowContrast">
                Open Halo on {permission.deviceName} to allow this.
              </Text>
            )}
            <Flex
              row
              gap={3}
              style={{ justifyContent: "flex-end", flexWrap: "wrap" }}
            >
              <Button
                variant="quiet"
                isDisabled={disabled}
                onClick={() => respond.mutate("deny")}
              >
                Don't allow
              </Button>
              {onThisComputer &&
                request.kind === "folder" &&
                request.access === "read" && (
                  <Button
                    isDisabled={disabled}
                    onClick={() => respond.mutate("read")}
                  >
                    Allow read only
                  </Button>
                )}
              {onThisComputer && (
                <Button
                  variant="primary"
                  variantColor="#1A73E8"
                  isDisabled={disabled}
                  onClick={() => respond.mutate("write")}
                >
                  {request.kind === "commands"
                    ? "Allow commands"
                    : "Allow read and write"}
                </Button>
              )}
            </Flex>
          </Flex>
        ) : (
          <Flex row style={{ justifyContent: "flex-end" }}>
            <Text size="sm" color="lowContrast" role="status">
              <Flex row gap={2} alignItems="center">
                {approval.status === "allowed" ? (
                  <Check size="sm" />
                ) : (
                  <Close size="sm" />
                )}
                {approval.status === "allowed"
                  ? "Allowed"
                  : approval.status === "denied"
                    ? "Not allowed"
                    : "Cancelled"}
              </Flex>
            </Text>
          </Flex>
        )}
      </Flex>
    </section>
  );
}

function permissionCopy(permission: DevicePermission) {
  const { request, deviceName } = permission;
  const home = (target: string) => homeRelative(target, permission.deviceHome);
  if (request.kind === "commands")
    return {
      title: `Allow Halo to run commands on ${deviceName}?`,
      description: `The agent wants to run this in ${home(request.cwd)}. Commands run as you, with full access to your files, including folders you have not allowed.`,
    };
  const verb = request.access === "write" ? "change" : "read";
  return {
    title: `Allow Halo to ${verb} files in ${home(request.folder)}?`,
    description: `The agent asked to ${verb} ${home(request.path)} on ${deviceName}. Your answer covers this folder and its subfolders.`,
  };
}

function homeRelative(target: string, home: string) {
  if (home === "") return target;
  if (target === home) return "your home folder";
  return target.startsWith(`${home}/`)
    ? `~/${target.slice(home.length + 1)}`
    : target;
}
