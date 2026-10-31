import { useState } from "react";
import type { Key } from "react-aria-components";
import { Button, Menu, MenuItem, MenuTrigger, Text, colors, flex } from "maui";
import { Apps, Clock, File, Filters, Folder, Plus } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useExtensions } from "../api/WorkspaceUpdatesProvider.js";
import { useDatabaseQuery } from "../database/useDatabaseQuery.js";
import { useWorkspaceDataSynced } from "../database/WorkspaceDataProvider.js";
import { AutomationItems } from "./AutomationItems.js";
import { ExtensionItems } from "./ExtensionItems.js";
import { FilesystemSection } from "./FilesystemSection.js";
import type { ArtifactFilter } from "./SidebarPreferences.js";
import {
  useSidebarPreferences,
  useSidebarPreferenceState,
} from "./SidebarPreferencesProvider.js";
import { SidebarEmptyState } from "./SidebarEmptyState.js";

const filters = [
  { id: "all", label: "All" },
  { id: "documents", label: "Docs", icon: File },
  { id: "extensions", label: "Extensions", icon: Apps },
  { id: "automations", label: "Automations", icon: Clock },
] as const;

export function ArtifactsSection({
  paths,
  pending,
  error,
}: {
  paths: string[];
  pending: boolean;
  error?: string;
}) {
  const preferences = useSidebarPreferences();
  const [entryRequest, setEntryRequest] = useState<{
    kind: "file" | "directory";
    sequence: number;
  }>({ kind: "file", sequence: 0 });
  const [filesBusy, setFilesBusy] = useState(false);
  const { artifactFilter } = useSidebarPreferenceState();
  const extensions = useExtensions();
  const automations = useDatabaseQuery({
    collection: "automations",
    orderBy: { createdAt: "asc", id: "asc" },
  });
  const extensionCount = new Set([
    ...(extensions.data ?? []).map((extension) => extension.id),
    ...(automations ?? []).flatMap((automation) =>
      automation.extensionId === undefined ? [] : [automation.extensionId],
    ),
  ]).size;
  const standaloneCount = (automations ?? []).filter(
    (automation) => automation.extensionId === undefined,
  ).length;
  const counts = {
    all: paths.length + extensionCount + standaloneCount,
    documents: paths.length,
    extensions: extensionCount,
    automations: automations?.length ?? 0,
  };
  // Wait for every source so the empty state does not flash while loading.
  const synced = useWorkspaceDataSynced();
  const loaded =
    !pending &&
    synced &&
    automations !== undefined &&
    (extensions.data !== undefined || extensions.error !== undefined);
  const show = (filter: ArtifactFilter) =>
    artifactFilter === "all" || artifactFilter === filter;
  return (
    <FilesystemSection
      key={entryRequest.sequence}
      paths={paths}
      error={error}
      createEntry={entryRequest.sequence > 0 ? entryRequest.kind : undefined}
      onBusyChange={setFilesBusy}
      label={
        <>
          Artifacts
          {extensions.error !== undefined && (
            <Text size="xs" role="alert">
              : {extensions.error.message}
            </Text>
          )}
        </>
      }
      actions={
        <>
          <ArtifactFilterMenu />
          <MenuTrigger placement="bottom end">
            <Button
              size="sm"
              variant="quiet"
              aria-label="Create artifact"
              isDisabled={filesBusy}
            >
              <Plus size="sm" />
            </Button>
            <Menu
              aria-label="Create artifact"
              onAction={(key) => {
                if (key !== "file" && key !== "directory") return;
                preferences.revealDocuments();
                setEntryRequest((request) => ({
                  kind: key,
                  sequence: request.sequence + 1,
                }));
              }}
            >
              <MenuItem id="file" textValue="File">
                <File size="sm" /> File
              </MenuItem>
              <MenuItem id="directory" textValue="Folder">
                <Folder size="sm" /> Folder
              </MenuItem>
            </Menu>
          </MenuTrigger>
        </>
      }
      showFiles={show("documents")}
      emptyState={
        loaded && counts[artifactFilter] === 0 ? (
          // React Aria rejects id changes on a mounted row.
          <SidebarEmptyState key={artifactFilter}>
            {`No ${artifactFilter === "all" ? "artifacts" : artifactFilter} yet`}
          </SidebarEmptyState>
        ) : undefined
      }
    >
      {show("extensions") && <ExtensionItems />}
      {show("automations") && (
        <AutomationItems includeExtensions={artifactFilter === "automations"} />
      )}
    </FilesystemSection>
  );
}

function ArtifactFilterMenu() {
  const preferences = useSidebarPreferences();
  const { artifactFilter } = useSidebarPreferenceState();
  const option = useStyles(styles.option);
  const optionIcon = useStyles(styles.optionIcon);
  const trigger = useStyles(styles.trigger);
  return (
    <MenuTrigger placement="bottom end">
      <Button
        size="sm"
        variant="quiet"
        aria-label="Filter artifacts"
        className={trigger}
        data-filtered={artifactFilter !== "all" || undefined}
      >
        <Filters size="sm" />
      </Button>
      <Menu
        aria-label="Show artifacts"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[artifactFilter]}
        onAction={(key: Key) => {
          const filter = filters.find((item) => item.id === key);
          if (filter !== undefined) preferences.setArtifactFilter(filter.id);
        }}
      >
        {filters.map((filter) => (
          <MenuItem key={filter.id} id={filter.id} textValue={filter.label}>
            <span className={option}>
              <span className={optionIcon} aria-hidden="true">
                {"icon" in filter && <filter.icon size="sm" />}
              </span>
              {filter.label}
            </span>
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
  );
}

const styles = {
  // Inline so Maui's selected checkmark stays on the same line.
  option: style(flex({ alignItems: "center", gap: 2 }), {
    display: "inline-flex",
    verticalAlign: "middle",
    paddingRight: "20px",
  }),
  optionIcon: style({
    display: "grid",
    placeItems: "center",
    width: "16px",
    color: colors.gray[11],
  }),
  trigger: style({
    color: colors.gray[10],
    "&[data-filtered]": { color: colors.gray[12] },
  }),
};
