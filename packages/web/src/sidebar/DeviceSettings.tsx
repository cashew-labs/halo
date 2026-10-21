import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Flex,
  RadioOption,
  RadioOptionGroup,
  Switch,
  Text,
  flex,
  text,
} from "maui";
import { style, useStyles } from "purse-styles";
import type {
  HostApi,
  LocalDeviceState,
  LocalDeviceUpdate,
} from "../HostApi.js";
import { problemStyle } from "./PublisherSettings.js";

const deviceQueryKey = ["local-device"];
const accessLevels = ["off", "read", "write"] as const;

/** Lets the person decide what the workspace agent may do on this computer. */
export function DeviceSettings({
  device,
}: {
  device: NonNullable<HostApi["device"]>;
}) {
  const queryClient = useQueryClient();
  const hint = useStyles(hintStyle);
  const problem = useStyles(hintStyle, problemStyle);
  const folderRow = useStyles(folderRowStyle);
  const folderPath = useStyles(folderPathStyle);
  const section = useStyles(sectionStyle);
  // A long path would otherwise shrink Remove below its label.
  const removeButton = useStyles(removeButtonStyle);
  const state = useQuery({
    queryKey: deviceQueryKey,
    queryFn: async () => await unwrap(device.read()),
    // The connection status changes without a settings change.
    refetchInterval: 2_000,
  });
  const save = useMutation({
    mutationFn: async (
      change: { update: LocalDeviceUpdate } | { addFolder: true },
    ) =>
      await unwrap(
        "addFolder" in change
          ? device.addFolder()
          : device.update(change.update),
      ),
    onSuccess: (saved) => queryClient.setQueryData(deviceQueryKey, saved),
  });
  const current = state.data;
  if (current === undefined)
    return state.error == undefined ? undefined : (
      <p role="alert" className={problem}>
        {state.error.message}
      </p>
    );
  const update = (change: LocalDeviceUpdate) => save.mutate({ update: change });
  const { files } = current;
  return (
    <section aria-labelledby="device-settings-label" className={section}>
      <Text id="device-settings-label" size="xs" fontWeight={600}>
        This computer
      </Text>
      <Switch
        label={`Let Halo use ${current.name}`}
        selected={current.enabled}
        onChange={(enabled) => update({ enabled })}
      />
      <p role="status" aria-live="polite" className={hint}>
        {statusText(current)}
      </p>
      {current.enabled && (
        <>
          <RadioOptionGroup
            label="Files"
            value={files.access}
            onChange={(value) => {
              const access = accessLevels.find((level) => level === value);
              if (access !== undefined) update({ files: { ...files, access } });
            }}
            isDisabled={save.isPending}
          >
            <RadioOption value="off">Off</RadioOption>
            <RadioOption value="read">Read only</RadioOption>
            <RadioOption value="write">Read and write</RadioOption>
          </RadioOptionGroup>
          {files.access !== "off" && (
            <Flex column gap={2}>
              {files.roots.length === 0 && (
                <p className={hint}>
                  Add a folder for the agent to use. Other folders stay private.
                </p>
              )}
              {files.roots.map((root) => (
                <div key={root} className={folderRow}>
                  <span className={folderPath} title={root}>
                    {root}
                  </span>
                  <Button
                    variant="quiet"
                    size="sm"
                    className={removeButton}
                    aria-label={`Stop sharing ${root}`}
                    isDisabled={save.isPending}
                    onPress={() =>
                      update({
                        files: {
                          ...files,
                          roots: files.roots.filter((entry) => entry !== root),
                        },
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                isDisabled={save.isPending}
                onPress={() => save.mutate({ addFolder: true })}
              >
                Add folder…
              </Button>
              <p className={hint}>
                Credential folders such as ~/.ssh are never shared.
              </p>
            </Flex>
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

const removeButtonStyle = style({ flexShrink: 0 });
const sectionStyle = style(flex({ direction: "column", gap: 3 }));
const hintStyle = style(text({ size: "xs", color: "lowContrast" }), {
  margin: 0,
});
const folderRowStyle = style(
  flex({ alignItems: "center", justifyContent: "between", gap: 3 }),
);
const folderPathStyle = style(text({ size: "xs" }), {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
