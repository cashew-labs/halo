import {
  NavigationTreeItem,
  NavigationTreeItemContent,
} from "react-aria-components/NavigationTree";
import { Text, flex, spacing } from "maui";
import { style, useStyles } from "purse-styles";
import { sidebarPadding } from "./navigation/SidebarSection.js";

export function SidebarEmptyState({
  kind,
}: {
  kind:
    | "artifacts"
    | "documents"
    | "extensions"
    | "automations"
    | "threads"
    | "favorites";
}) {
  const row = useStyles(styles.row);
  const message = useStyles(styles.message);
  return (
    <NavigationTreeItem
      id={`empty-${kind}`}
      textValue={
        kind === "favorites"
          ? "Star an item to keep it here."
          : `No ${kind} yet`
      }
      className={row}
    >
      <NavigationTreeItemContent>
        <Text size="2xs" color="lowContrast" className={message}>
          {kind === "favorites"
            ? "Star an item to keep it here."
            : `No ${kind} yet`}
        </Text>
      </NavigationTreeItemContent>
    </NavigationTreeItem>
  );
}

const styles = {
  row: style(
    sidebarPadding,
    spacing.padding({ y: 2 }),
    flex({ direction: "column", alignItems: "center", gap: 0 }),
    { textAlign: "center" },
  ),
  message: style({ fontStyle: "italic" }),
};
