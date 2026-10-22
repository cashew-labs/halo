import { FileSaveErrorIndicator } from "../FileSaveErrorIndicator.js";
import { SidebarFooter } from "./SidebarFooter.js";
import { useSidebar } from "../WorkspaceLayout.js";
import { Fragment, useState } from "react";
import {
  Button,
  Tooltip,
  backgroundColor,
  colors,
  flex,
  flexItem,
  spacing,
} from "maui";
import { Close, FilePlus, FolderPlus, Edit, Monitor } from "maui/icons";
import { style, useStyles } from "purse-styles";
import type { ThreadSummary } from "@get-halo/client";
import type { AppInfo } from "../HostApi.js";
import { ArtifactsSection } from "./ArtifactsSection.js";
import { ThreadsSection } from "./ThreadsSection.tsx";
import {
  NavigationSidebar,
  useExpandedSidebar,
} from "./navigation/NavigationSidebar.js";
import { useDirectoryListings } from "../filesystem/useDirectoryListings.js";
import {
  useSidebarPreferences,
  useSidebarPreferenceState,
} from "./SidebarPreferencesProvider.js";
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
  const preferences = useSidebarPreferences();
  const [entryRequest, setEntryRequest] = useState<{
    kind: "file" | "directory";
    sequence: number;
  }>({ kind: "file", sequence: 0 });
  const [filesBusy, setFilesBusy] = useState(false);
  const actions = useStyles(styles.actions);
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
      <div className={actions} role="toolbar" aria-label="Workspace actions">
        <Tooltip content="New thread" placement="bottom">
          <Button
            variant="quiet"
            aria-label="New thread"
            onPress={() => {
              workspace.open({
                path: `/draft/${crypto.randomUUID()}`,
                newTab: true,
              });
              close();
            }}
          >
            <Edit size="md" />
          </Button>
        </Tooltip>
        <Tooltip content="New Markdown file" placement="bottom">
          <Button
            variant="quiet"
            aria-label="New Markdown file"
            isDisabled={filesBusy}
            onPress={() => {
              preferences.revealDocuments();
              setEntryRequest((request) => ({
                kind: "file",
                sequence: request.sequence + 1,
              }));
            }}
          >
            <FilePlus size="md" />
          </Button>
        </Tooltip>
        <Tooltip content="New folder" placement="bottom">
          <Button
            variant="quiet"
            aria-label="New folder"
            isDisabled={filesBusy}
            onPress={() => {
              preferences.revealDocuments();
              setEntryRequest((request) => ({
                kind: "directory",
                sequence: request.sequence + 1,
              }));
            }}
          >
            <FolderPlus size="md" />
          </Button>
        </Tooltip>
        <Tooltip content="Desktop" placement="bottom">
          <Button
            variant="quiet"
            aria-label="Desktop"
            onPress={() => {
              workspace.open({ path: "/desktop" });
              close();
            }}
          >
            <Monitor size="md" />
          </Button>
        </Tooltip>
      </div>
      <NavigationSidebar aria-label="Workspace" className={navigation}>
        <SidebarContents
          threads={threads}
          entryRequest={entryRequest}
          onFilesBusyChange={setFilesBusy}
        />
      </NavigationSidebar>
      <div className={footer} data-testid="app-update-status">
        <SidebarFooter appInfo={appInfo} />
        <FileSaveErrorIndicator />
      </div>
    </nav>
  );
}

function SidebarContents({
  threads,
  entryRequest,
  onFilesBusyChange,
}: {
  threads: ThreadSummary[];
  entryRequest: { kind: "file" | "directory"; sequence: number };
  onFilesBusyChange(busy: boolean): void;
}) {
  const expanded = useExpandedSidebar();
  const { favoriteIds, sectionOrder } = useSidebarPreferenceState();
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
  const sections = {
    favorites: (
      <FavoritesSection
        threads={threads}
        paths={listing.paths}
        filesPending={listing.pending}
      />
    ),
    artifacts: (
      <ArtifactsSection
        key={entryRequest.sequence}
        paths={listing.paths}
        pending={listing.pending}
        error={listing.error}
        createEntry={entryRequest.sequence > 0 ? entryRequest.kind : undefined}
        onBusyChange={onFilesBusyChange}
      />
    ),
    sessions: <ThreadsSection threads={threads} />,
  };
  return sectionOrder.map((sectionId) => (
    <Fragment key={sectionId}>{sections[sectionId]}</Fragment>
  ));
}

const styles = {
  actions: style(flex({ alignItems: "center", gap: 2 }), sidebarPadding, {
    flexShrink: 0,
    "@media (max-width: 700px)": { paddingBottom: spacing.value(4) },
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
