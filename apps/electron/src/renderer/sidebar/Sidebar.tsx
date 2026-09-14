import { Button, colors, flex, flexItem, shadow, spacing, text } from "maui";
import { Plus } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useLocation } from "wouter";
import type { SessionSummary } from "@get-halo/shared/rpc";
import type { AppInfo } from "../../shared/desktop.js";
import { useInstallAppUpdateMutation } from "../api/ApiProvider.tsx";
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
  const sidebar = useStyles(styles.sidebar);
  const titleBar = useStyles(styles.titleBar);
  const newButton = useStyles(styles.newButton);
  const navigation = useStyles(styles.navigation);
  const footer = useStyles(styles.footer);
  const versionLabel = useStyles(styles.versionLabel);
  const updateLabel = useStyles(styles.updateLabel);
  const newSessionPad = useStyles(sidebarPadding);

  return (
    <nav className={sidebar} aria-label="Workspace">
      <div className={titleBar} aria-hidden="true" />
      <div className={newSessionPad}>
        <NewSessionButton className={newButton} />
      </div>
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

function NewSessionButton({ className }: { className: string }) {
  const [, navigate] = useLocation();
  return (
    <Button
      className={className}
      onClick={() => navigate(`/draft/${crypto.randomUUID()}`)}
    >
      <Plus size="sm" aria-hidden="true" />
      New session
    </Button>
  );
}

function UpdateFooter({
  appInfo,
  labelClassName,
}: {
  appInfo: AppInfo;
  labelClassName: string;
}) {
  const install = useInstallAppUpdateMutation();
  const restartButton = useStyles(styles.restartButton);
  if (appInfo.update.state === "downloaded") {
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
  }),
  titleBar: style({
    minHeight: "36px",
    flexShrink: 0,
    WebkitAppRegion: "drag",
  }),
  newButton: style(flex({ align: "center", gap: 3 }), {
    alignSelf: "stretch",
    width: "100%",
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
