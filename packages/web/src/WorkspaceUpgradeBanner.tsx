import { Text, colors, spacing } from "maui";
import { style, useStyles } from "purse-styles";
import { useConnection } from "./api/ConnectionContext.js";

export function WorkspaceUpgradeBanner() {
  const { state } = useConnection();
  const banner = useStyles(bannerStyle);
  if (state.status !== "upgrading") return;
  return (
    <div role="status" aria-live="polite" className={banner}>
      <Text>Upgrading your workspace. Halo will reconnect automatically.</Text>
    </div>
  );
}
const bannerStyle = style({
  padding: spacing.value(4),
  backgroundColor: colors.blue[3],
  color: colors.blue[12],
});
