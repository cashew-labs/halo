import type { Key } from "react-aria-components";
import { Button, Menu, MenuItem, MenuTrigger, Text, colors, flex } from "maui";
import { Apps, Clock, File, Filter } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useExtensions } from "../api/WorkspaceUpdatesProvider.js";
import { useDatabaseQuery } from "../database/useDatabaseQuery.js";
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
  createEntry,
  onBusyChange,
}: {
  paths: string[];
  pending: boolean;
  error?: string;
  createEntry: "file" | "directory" | undefined;
  onBusyChange(busy: boolean): void;
}) {
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
  const loaded =
    !pending &&
    automations !== undefined &&
    (extensions.data !== undefined || extensions.error !== undefined);
  const show = (filter: ArtifactFilter) =>
    artifactFilter === "all" || artifactFilter === filter;
  return (
    <FilesystemSection
      paths={paths}
      error={error}
      createEntry={createEntry}
      onBusyChange={onBusyChange}
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
      actions={<ArtifactFilterMenu />}
      showFiles={show("documents")}
      emptyState={
        loaded && counts[artifactFilter] === 0 ? (
          <SidebarEmptyState
            // React Aria rejects id changes on a mounted row.
            key={artifactFilter}
            kind={artifactFilter === "all" ? "artifacts" : artifactFilter}
          />
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
        <Filter size="sm" />
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
