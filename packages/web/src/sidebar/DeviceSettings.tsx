import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Switch, Text, flex, text } from "maui";
import { style, useStyles } from "purse-styles";
import type {
  HostApi,
  LocalDeviceState,
  LocalDeviceUpdate,
} from "../HostApi.js";
import { problemStyle } from "./PublisherSettings.js";

const deviceQueryKey = ["local-device"];

/** Shows what the workspace agent may do on this computer. */
export function DeviceSettings({
  device,
}: {
  device: NonNullable<HostApi["device"]>;
}) {
  const queryClient = useQueryClient();
  const hint = useStyles(hintStyle);
  const problem = useStyles(hintStyle, problemStyle);
  const section = useStyles(sectionStyle);
  const list = useStyles(listStyle);
  const folderRow = useStyles(folderRowStyle);
  const folderPath = useStyles(folderPathStyle);
  // A long path would otherwise shrink Remove below its label.
  const removeButton = useStyles(removeButtonStyle);
  const state = useQuery({
    queryKey: deviceQueryKey,
    queryFn: async () => await unwrap(device.read()),
    // Connection status and new grants change outside this dialog.
    refetchInterval: 2_000,
  });
  const save = useMutation({
    mutationFn: async (update: LocalDeviceUpdate) =>
      await unwrap(device.update(update)),
    onSuccess: (saved) => queryClient.setQueryData(deviceQueryKey, saved),
  });
  const current = state.data;
  if (current === undefined)
    return state.error == undefined ? undefined : (
      <p role="alert" className={problem}>
        {state.error.message}
      </p>
    );
  const { grants } = current.files;
  return (
    <section aria-labelledby="device-settings-label" className={section}>
      <Text id="device-settings-label" size="xs" fontWeight={600}>
        This computer
      </Text>
      <Switch
        label={`Let Halo use ${current.name}`}
        selected={current.enabled}
        onChange={(enabled) => save.mutate({ enabled })}
      />
      <p role="status" aria-live="polite" className={hint}>
        {statusText(current)}
      </p>
      {current.enabled && (
        <>
          <p className={hint}>
            Halo asks here before the agent uses a new folder. Credential
            folders such as ~/.ssh are never shared.
          </p>
          {grants.length > 0 && (
            <ul aria-label="Allowed folders" className={list}>
              {grants.map((grant) => (
                <li key={grant.path} className={folderRow}>
                  <span className={folderPath} title={grant.path}>
                    {grant.path}
                  </span>
                  <Text size="xs" color="lowContrast">
                    {grant.access === "write" ? "Read and write" : "Read only"}
                  </Text>
                  <Button
                    variant="quiet"
                    size="sm"
                    className={removeButton}
                    aria-label={`Stop allowing ${grant.path}`}
                    isDisabled={save.isPending}
                    onPress={() =>
                      save.mutate({
                        files: {
                          grants: grants.filter(
                            (entry) => entry.path !== grant.path,
                          ),
                        },
                      })
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {save.error != undefined && (
        <p role="alert" className={problem}>
          {save.error.message}
        </p>
      )}
    </section>
  );
}

function statusText(state: LocalDeviceState) {
  switch (state.status.state) {
    case "disabled":
      return "The workspace agent cannot use this computer.";
    case "connecting":
      return "Connecting to your workspace…";
    case "online":
      return `Connected. The agent can reach this computer as “${state.name}”.`;
    case "offline":
      return `Not connected: ${state.status.message}. Retrying.`;
  }
}

async function unwrap(result: Promise<LocalDeviceState | Error>) {
  const value = await result;
  if (value instanceof Error) throw value;
  return value;
}

const sectionStyle = style(flex({ direction: "column", gap: 3 }));
const listStyle = style(flex({ direction: "column", gap: 2 }), {
  margin: 0,
  padding: 0,
  listStyle: "none",
});
const hintStyle = style(text({ size: "xs", color: "lowContrast" }), {
  margin: 0,
});
const folderRowStyle = style(flex({ alignItems: "center", gap: 3 }));
const folderPathStyle = style(text({ size: "xs" }), {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
const removeButtonStyle = style({ flexShrink: 0 });
