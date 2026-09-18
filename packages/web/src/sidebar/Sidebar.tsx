import { useSidebar } from "../WorkspaceLayout.js";
import { Button, colors, flex, flexItem, shadow, spacing, text } from "maui";
import { Close } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useMutation } from "@tanstack/react-query";
import type { SessionSummary } from "@get-halo/client";
import type { AppInfo } from "../HostApi.js";
import { useHost } from "../HostProvider.js";
import { FilesystemSection } from "./FilesystemSection.tsx";
import { SessionsSection } from "./SessionsSection.tsx";
import { ExtensionsSection } from "./ExtensionsSection.js";
import { NavigationSidebar } from "./navigation/NavigationSidebar.js";
import { sidebarPadding } from "./navigation/SidebarSection.js";

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
  const versionLabel = useStyles(styles.versionLabel);
  const updateLabel = useStyles(styles.updateLabel);

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
        <FilesystemSection />
        <SessionsSection sessions={sessions} />
        <ExtensionsSection />
      </NavigationSidebar>
      {appInfo !== undefined && (
        <div className={footer} data-testid="app-update-status">
          <div className={versionLabel}>Halo {appInfo.version}</div>
          <UpdateFooter appInfo={appInfo} labelClassName={updateLabel} />
        </div>
      )}
    </nav>
  );
}

function UpdateFooter({
  appInfo,
  labelClassName,
}: {
  appInfo: AppInfo;
  labelClassName: string;
}) {
  const host = useHost();
  const install = useMutation({
    mutationFn: async () => {
      if (host.installAppUpdate === undefined) return;
      const result = await host.installAppUpdate();
      if (result instanceof Error) throw result;
    },
  });
  const restartButton = useStyles(styles.restartButton);
  if (
    appInfo.update.state === "downloaded" &&
    host.installAppUpdate !== undefined
  ) {
    return (
      <Button
        className={restartButton}
        data-testid="app-update-restart"
        onClick={() => install.mutate()}
      >
        Restart to update
      </Button>
    );
  }
  return (
    <div className={labelClassName}>{formatUpdateStatus(appInfo.update)}</div>
  );
}

function formatUpdateStatus(update: AppInfo["update"]): string {
  switch (update.state) {
    case "disabled":
      return update.reason;
    case "idle":
      return "Up to date · GitHub Releases";
    case "checking":
      return "Checking for updates…";
    case "available":
      return "Update available — downloading…";
    case "downloaded":
      return `Update ${update.version} ready — restart to apply`;
    case "error":
      return `Update error: ${update.message}`;
  }
}

const styles = {
  sidebar: style(shadow.medium, flex({ direction: "column", gap: 4 }), {
    width: "100%",
    minWidth: 0,
    height: "100%",
    minHeight: 0,
    overflowY: "auto",
    position: "relative",
    zIndex: 1,
    backgroundColor: `light-dark(${colors.gray[1]}, ${colors.gray[2]})`,
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
  restartButton: style({
    alignSelf: "stretch",
    width: "100%",
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
  versionLabel: style(
    text({ size: "xs", fontWeight: 500, color: "highContrast" }),
    {
      minWidth: 0,
    },
  ),
  updateLabel: style(
    text({ size: "xs", fontWeight: 400, color: "lowContrast" }),
    {
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
  ),
};
