import { FileSaveErrorIndicator } from "../FileSaveErrorIndicator.js";
import { SidebarFooter } from "./SidebarFooter.js";
import { useSidebar } from "../WorkspaceLayout.js";
import { Button, backgroundColor, flex, flexItem, shadow, spacing } from "maui";
import { Close, Monitor } from "maui/icons";
import { style, useStyles } from "purse-styles";
import type { SessionSummary } from "@get-halo/client";
import type { AppInfo } from "../HostApi.js";
import { FilesystemSection } from "./FilesystemSection.tsx";
import { SessionsSection } from "./SessionsSection.tsx";
import { ExtensionsSection } from "./ExtensionsSection.js";
import { ScheduledSection } from "./ScheduledSection.js";
import { NavigationSidebar } from "./navigation/NavigationSidebar.js";
import { sidebarPadding } from "./navigation/SidebarSection.js";
import { SidebarItem } from "./navigation/SidebarItem.js";

type SidebarProps = {
  sessions: SessionSummary[];
  appInfo?: AppInfo;
};

export function Sidebar({ sessions, appInfo }: SidebarProps) {
  const { isMobile, close } = useSidebar();
  const mobileHeader = useStyles(styles.mobileHeader);
  const closeButton = useStyles(styles.closeButton);
  const sidebar = useStyles(styles.sidebar);
  const titleBar = useStyles(styles.titleBar);
  const navigation = useStyles(styles.navigation);
  const footer = useStyles(styles.footer);

  return (
    <nav className={sidebar} aria-label="Workspace">
      {isMobile ? (
        <div className={mobileHeader}>
          <Button
            variant="quiet"
            aria-label="Close sidebar"
            className={closeButton}
            onClick={close}
          >
            <Close size="md" />
          </Button>
        </div>
      ) : (
        <div className={titleBar} aria-hidden="true" />
      )}
      <NavigationSidebar aria-label="Workspace" className={navigation}>
        <SidebarItem
          id="desktop"
          href="/desktop"
          pageTitle="Desktop"
          icon={Monitor}
        >
          Desktop
        </SidebarItem>
        <ScheduledSection />
        <ExtensionsSection />
        <FilesystemSection />
        <SessionsSection sessions={sessions} />
      </NavigationSidebar>
      <div className={footer} data-testid="app-update-status">
        <SidebarFooter appInfo={appInfo} />
        <FileSaveErrorIndicator />
      </div>
    </nav>
  );
}

const styles = {
  sidebar: style(shadow.medium, flex({ direction: "column", gap: 4 }), {
    width: "100%",
    minWidth: 0,
    height: "100%",
    minHeight: 0,
    // Electron ignores -webkit-app-region: drag inside overflow:auto ancestors.
    overflow: "hidden",
    position: "relative",
    zIndex: 1,
    backgroundColor: backgroundColor.element,
    "@media (max-width: 700px)": {
      gap: 0,
      paddingBottom: "env(safe-area-inset-bottom)",
    },
  }),
  mobileHeader: style(flex({ alignItems: "center", gap: 3 }), {
    minHeight: "56px",
    padding: "6px 2px",
    paddingTop: "max(6px, env(safe-area-inset-top))",
    flexShrink: 0,
  }),
  closeButton: style({ minWidth: "44px", minHeight: "44px", flexShrink: 0 }),
  titleBar: style({
    minHeight: "36px",
    flexShrink: 0,
    WebkitAppRegion: "drag",
  }),
  navigation: style(flexItem({ size: "auto" }), {
    minHeight: 0,
    overflow: "auto",
  }),
  footer: style(
    flex({ direction: "column", gap: 1 }),
    sidebarPadding,
    flexItem({ size: "hug" }),
    {
      marginTop: "auto",
      minWidth: 0,
      paddingTop: spacing.value(4),
      paddingBottom: spacing.value(8),
    },
  ),
};
