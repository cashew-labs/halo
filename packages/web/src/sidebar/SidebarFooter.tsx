import { Button, Tooltip, flex, spacing, text } from "maui";
import { ArrowUpCircle } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useMutation } from "@tanstack/react-query";
import { ConnectionStatus } from "../ConnectionStatus.js";
import { confirmRestart } from "../confirmRestart.js";
import type { AppInfo } from "../HostApi.js";
import { useHost } from "../HostProvider.js";

export function SidebarFooter({ appInfo }: { appInfo?: AppInfo }) {
  const row = useStyles(rowStyle);
  const version = useStyles(versionStyle);
  const connection = useStyles(connectionStyle);
  return (
    <div className={row}>
      {appInfo !== undefined && (
        <>
          <span className={version}>
            {appInfo.development ? "DEV" : appInfo.version}
          </span>
          <UpgradeIcon appInfo={appInfo} />
        </>
      )}
      <div className={connection}>
        <ConnectionStatus />
      </div>
    </div>
  );
}

function UpgradeIcon({ appInfo }: { appInfo: AppInfo }) {
  const host = useHost();
  const icon = useStyles(iconStyle);
  const install = useMutation({
    mutationFn: async () => {
      if (host.installAppUpdate === undefined || !confirmRestart()) return;
      const result = await host.installAppUpdate();
      if (result instanceof Error) throw result;
    },
  });
  if (
    appInfo.update.state !== "available" &&
    appInfo.update.state !== "downloaded"
  )
    return;
  const ready = appInfo.update.state === "downloaded";
  const label = ready ? "Restart to update" : "Downloading update";
  return (
    <Tooltip content={install.error?.message ?? label} placement="top">
      <Button
        variant="quiet"
        className={icon}
        aria-label={label}
        data-testid="app-update-restart"
        isDisabled={
          !ready || host.installAppUpdate === undefined || install.isPending
        }
        onClick={() => install.mutate()}
      >
        <ArrowUpCircle size="xs" />
      </Button>
    </Tooltip>
  );
}

const rowStyle = style(flex({ alignItems: "center", gap: 3 }), {
  minWidth: 0,
});
const versionStyle = style(text({ size: "xs", color: "lowContrast" }), {
  flexShrink: 0,
});
const connectionStyle = style({ marginLeft: "auto", whiteSpace: "nowrap" });
const iconStyle = style({
  minWidth: 24,
  minHeight: 24,
  padding: spacing.value(2),
});
