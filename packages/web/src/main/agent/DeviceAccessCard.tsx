import { useEffect } from "react";
import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  background,
  Button,
  CodeBlock,
  Flex,
  radius,
  shadow,
  Text,
} from "maui";
import { Monitor, Folder, ShieldTick } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useHost } from "../../HostProvider.js";
import type {
  LocalDeviceAccessAnswer,
  LocalDeviceAccessRequest,
} from "../../HostApi.js";

const requestsKey = ["local-device-access"];
const cardStyle = style(background.element, radius.lg, shadow.subtle, {
  width: "100%",
  maxWidth: "400px",
  overflowWrap: "anywhere",
});

/** The desktop publishes these requests; a browser cannot answer for it. */
export function useDeviceAccessRequests() {
  const { device } = useHost();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: requestsKey,
    queryFn:
      device === undefined
        ? skipToken
        : async () => {
            const requests = await device.readAccessRequests();
            if (requests instanceof Error) throw requests;
            return requests;
          },
  });
  useEffect(
    () =>
      device?.onAccessRequests(() => {
        queryClient
          .invalidateQueries({ queryKey: requestsKey })
          .catch((cause: unknown) => {
            console.warn(
              "Could not refresh device permission requests:",
              cause,
            );
          });
      }),
    [device, queryClient],
  );
  return query.data ?? [];
}

export function DeviceAccessCard({
  request,
}: {
  request: LocalDeviceAccessRequest;
}) {
  const { device } = useHost();
  const card = useStyles(cardStyle);
  const queryClient = useQueryClient();
  const respond = useMutation({
    mutationFn: async (answer: LocalDeviceAccessAnswer) => {
      if (device === undefined) return;
      const result = await device.respondToAccessRequest({
        requestId: request.id,
        answer,
      });
      if (result instanceof Error) throw result;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: requestsKey });
    },
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (device === undefined) return;
      const current = await device.read();
      if (current instanceof Error) throw current;
      const prompt = request.prompt;
      const saved = await device.update(
        prompt.kind === "commands"
          ? { commands: { allowed: false } }
          : {
              files: {
                grants: current.files.grants.filter(
                  (grant) => grant.path !== prompt.folder,
                ),
              },
            },
      );
      if (saved instanceof Error) throw saved;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: requestsKey });
    },
  });
  const prompt = request.prompt;
  const commands = prompt.kind === "commands";
  const pending = request.status === "pending";
  const allowed = ["read", "write", "allowed"].includes(request.status);
  const error = respond.error ?? remove.error;
  return (
    <section
      aria-label={
        commands ? "Run commands permission" : "Folder access permission"
      }
      data-testid="device-access-card"
      data-session-id={request.sessionId}
      className={card}
    >
      <Flex column gap={6} p={6}>
        <Flex row gap={4} alignItems="start">
          {commands ? <Monitor size="lg" /> : <Folder size="lg" />}
          <Flex column gap={1} style={{ minWidth: 0 }}>
            <Text size="md" fontWeight={600}>
              {commands
                ? "Run commands on this computer?"
                : prompt.access === "write"
                  ? "Change files in this folder?"
                  : "Read files in this folder?"}
            </Text>
            <Text size="sm" color="lowContrast">
              {commands
                ? "Commands run as you, with your full access, including folders you have not allowed."
                : prompt.folder}
            </Text>
          </Flex>
        </Flex>
        {commands ? (
          <Flex column gap={3} style={{ minWidth: 0 }}>
            <CodeBlock lang="sh">{prompt.command}</CodeBlock>
            <Text size="xs" color="lowContrast">
              Working folder: {prompt.cwd}
            </Text>
          </Flex>
        ) : (
          <Text size="sm" color="lowContrast">
            Your choice applies to this folder and its subfolders.
          </Text>
        )}
        {pending ? (
          <Flex
            row
            gap={3}
            style={{ flexWrap: "wrap", justifyContent: "flex-end" }}
          >
            <Button
              variant="quiet"
              isDisabled={respond.isPending}
              onPress={() => respond.mutate("deny")}
            >
              Don't allow
            </Button>
            {commands ? (
              <Button
                isDisabled={respond.isPending}
                onPress={() => respond.mutate("allowCommands")}
              >
                Allow commands
              </Button>
            ) : (
              <>
                <Button
                  isDisabled={respond.isPending}
                  onPress={() => respond.mutate("read")}
                >
                  Allow read only
                </Button>
                <Button
                  variant="primary"
                  isDisabled={respond.isPending}
                  onPress={() => respond.mutate("write")}
                >
                  Allow read and write
                </Button>
              </>
            )}
          </Flex>
        ) : (
          <Flex row gap={3} alignItems="center" justifyContent="end">
            {allowed && <ShieldTick size="sm" />}
            <Text size="sm" color="lowContrast" role="status">
              {statusLabels[request.status]}
            </Text>
            {allowed && (
              <Button
                variant="quiet"
                size="sm"
                isDisabled={remove.isPending}
                onPress={() => remove.mutate()}
              >
                Remove access
              </Button>
            )}
          </Flex>
        )}
        {error !== null && (
          <Text size="sm" role="alert">
            {error.message}
          </Text>
        )}
      </Flex>
    </section>
  );
}

const statusLabels = {
  pending: "Waiting for your choice",
  read: "Read only",
  write: "Read and write",
  allowed: "Commands allowed",
  denied: "Not allowed",
  cancelled: "Cancelled",
  removed: "Access removed",
} as const;
