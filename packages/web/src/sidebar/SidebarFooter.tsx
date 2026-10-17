import { Button, Tooltip, flex, spacing } from "maui";
import { ArrowUpCircle } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useAsyncAction } from "../useAsyncAction.js";
import { ConnectionStatus } from "../ConnectionStatus.js";
import { confirmRestart } from "../confirmRestart.js";
import type { AppInfo } from "../HostApi.js";
import { useHost } from "../HostProvider.js";
import { AccountButton } from "./AccountButton.js";

export function SidebarFooter({ appInfo }: { appInfo?: AppInfo }) {
  const row = useStyles(rowStyle);
  return (
    <div className={row}>
      <AccountButton appInfo={appInfo} />
      {appInfo !== undefined && <UpgradeIcon appInfo={appInfo} />}
      <ConnectionStatus dot />
    </div>
  );
}

function UpgradeIcon({ appInfo }: { appInfo: AppInfo }) {
  const host = useHost();
  const icon = useStyles(iconStyle);
  const install = useAsyncAction(async () => {
    if (host.installAppUpdate === undefined || !confirmRestart()) return;
    return await host.installAppUpdate();
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
          !ready || host.installAppUpdate === undefined || install.pending
        }
        onClick={() => void install.run()}
      >
        <ArrowUpCircle size="lg" />
      </Button>
    </Tooltip>
  );
}

const rowStyle = style(flex({ alignItems: "center", gap: 3 }), {
  minWidth: 0,
});
const iconStyle = style({
  minWidth: 24,
  minHeight: 24,
  padding: spacing.value(2),
});
