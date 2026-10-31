import { FileSaveErrorIndicator } from "../FileSaveErrorIndicator.js";
import { SidebarFooter } from "./SidebarFooter.js";
import { useSidebar } from "../WorkspaceLayout.js";
import { Button as NavigationButton } from "react-aria-components";
import {
  Button,
  backgroundColor,
  colors,
  flex,
  flexItem,
  focusRing,
  navigationItem,
  spacing,
} from "maui";
import { Close, Monitor } from "maui/icons";
import { style, useStyles } from "purse-styles";
import type { ThreadSummary } from "@get-halo/client";
import type { AppInfo } from "../HostApi.js";
import { ArtifactsSection } from "./ArtifactsSection.js";
import { ThreadsSection } from "./ThreadsSection.tsx";
import { AgentsSection } from "./AgentsSection.js";
import {
  NavigationSidebar,
  useExpandedSidebar,
} from "./navigation/NavigationSidebar.js";
import { useDirectoryListings } from "../filesystem/useDirectoryListings.js";
import { useSidebarPreferenceState } from "./SidebarPreferencesProvider.js";
import { FavoritesSection } from "./FavoritesSection.js";
import { sidebarPadding } from "./navigation/SidebarSection.js";
import { useWorkspacePanes } from "../panes/WorkspacePanesProvider.js";

type SidebarProps = {
  threads: ThreadSummary[];
  appInfo?: AppInfo;
};

export function Sidebar({ threads, appInfo }: SidebarProps) {
  const { isMobile, close } = useSidebar();
  const workspace = useWorkspacePanes();
  const actions = useStyles(styles.actions);
  const desktop = useStyles(styles.desktop);
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
      <AgentsSection threads={threads} />
      <div className={actions} role="toolbar" aria-label="Workspace actions">
        <NavigationButton
          className={desktop}
          onPress={() => {
            workspace.open({ path: "/desktop" });
            close();
          }}
        >
          <Monitor size="sm" />
          Desktop
        </NavigationButton>
      </div>
      <NavigationSidebar aria-label="Workspace" className={navigation}>
        <SidebarContents threads={threads} />
      </NavigationSidebar>
      <div className={footer} data-testid="app-update-status">
        <SidebarFooter appInfo={appInfo} />
        <FileSaveErrorIndicator />
      </div>
    </nav>
  );
}

function SidebarContents({ threads }: { threads: ThreadSummary[] }) {
  const expanded = useExpandedSidebar();
  const { favoriteIds } = useSidebarPreferenceState();
  const watched = new Set(expanded);
  for (const key of expanded) {
    const itemId = String(key);
    if (itemId.startsWith("favorite-file:"))
      watched.add(`file:${itemId.slice(itemId.indexOf("/") + 1)}`);
  }
  for (const favoriteId of favoriteIds) {
    if (!favoriteId.startsWith("file:")) continue;
    const segments = favoriteId.slice(5).split("/");
    for (let index = 1; index < segments.length; index++) {
      watched.add(`file:${segments.slice(0, index).join("/")}/`);
    }
  }
  const listing = useDirectoryListings(watched);
  return (
    <>
      <FavoritesSection
        threads={threads}
        paths={listing.paths}
        filesPending={listing.pending}
      />
      <ArtifactsSection
        paths={listing.paths}
        pending={listing.pending}
        error={listing.error}
      />
      <ThreadsSection threads={threads} />
    </>
  );
}

const styles = {
  actions: style({
    flexShrink: 0,
    "@media (max-width: 700px)": { paddingBottom: spacing.value(4) },
  }),
  desktop: style(navigationItem, sidebarPadding, focusRing(), {
    display: "flex",
    alignItems: "center",
    gap: spacing.value(3),
    width: "100%",
    height: "28px",
    paddingBlock: 0,
    border: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    textAlign: "left",
    "@media (max-width: 700px)": { height: "44px" },
  }),
  sidebar: style(flex({ direction: "column", gap: 4 }), {
    width: "100%",
    minWidth: 0,
    height: "100%",
    minHeight: 0,
    // Electron ignores -webkit-app-region: drag inside overflow:auto ancestors.
    overflow: "hidden",
    position: "relative",
    zIndex: 1,
    backgroundColor: backgroundColor.element,
    borderRight: `0.5px solid ${colors.gray[6]}`,
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
