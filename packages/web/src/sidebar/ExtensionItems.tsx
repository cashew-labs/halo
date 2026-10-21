import { useEffect, useEffectEvent } from "react";
import { Text } from "maui";
import * as MauiIcons from "maui/icons";
import { Apps, Clock, WarningTriangle } from "maui/icons";
import { useLocation } from "wouter";

import { useExtensions } from "../api/WorkspaceUpdatesProvider.js";
import { useDatabaseQuery } from "../database/useDatabaseQuery.js";
import { useApps } from "../panes/useApps.js";
import { useExpandSidebar } from "./navigation/NavigationSidebar.js";
import { SidebarItem } from "./navigation/SidebarItem.js";

const icons = new Map(Object.entries(MauiIcons));

// Extension rows and favorites read the same extension, automation, and app data.
export function useExtensionArtifacts() {
  const extensions = useExtensions();
  const automations = useDatabaseQuery({
    collection: "automations",
    orderBy: { createdAt: "asc", id: "asc" },
  });
  // Only a project that is moving to its own server needs the app list.
  const apps = useApps({
    enabled: (extensions.data ?? []).some(
      (extension) => extension.publishing !== undefined,
    ),
  });
  return { extensions, automations, apps };
}

type ExtensionArtifacts = ReturnType<typeof useExtensionArtifacts>;

// Extension rows keep their own icons; their automations are nested beneath them.
export function ExtensionItems() {
  const artifacts = useExtensionArtifacts();
  const { extensions, automations } = artifacts;
  const expand = useExpandSidebar();
  const [location] = useLocation();
  // Extensions with automations stay listed while their process is not running.
  const extensionIds = [
    ...new Set([
      ...(extensions.data ?? []).map((extension) => extension.id),
      ...(automations ?? []).flatMap((automation) =>
        automation.extensionId === undefined ? [] : [automation.extensionId],
      ),
    ]),
  ];
  const openExtensionId = automations?.find(
    (automation) =>
      location === `/automations/${encodeURIComponent(automation.id)}` ||
      location === `/routines/${encodeURIComponent(automation.id)}`,
  )?.extensionId;
  const expandExtension = useEffectEvent((extensionId: string) =>
    expand([`extension:${extensionId}`]),
  );

  // Reveal the open automation under its extension.
  useEffect(() => {
    if (openExtensionId !== undefined) expandExtension(openExtensionId);
  }, [openExtensionId]);

  return extensionIds.map((extensionId) => (
    <ExtensionItem
      key={extensionId}
      extensionId={extensionId}
      artifacts={artifacts}
    />
  ));
}

// Favorites prefix row IDs so the same extension can also appear under Artifacts.
export function ExtensionItem({
  extensionId,
  artifacts: { extensions, automations, apps },
  idPrefix = "",
}: {
  extensionId: string;
  artifacts: ExtensionArtifacts;
  idPrefix?: string;
}) {
  const extension = extensions.data?.find((item) => item.id === extensionId);
  const owned = (automations ?? []).filter(
    (automation) => automation.extensionId === extensionId,
  );
  const id = `${idPrefix}extension:${extensionId}`;
  return (
    <SidebarItem
      id={id}
      favoriteId={`extension:${extensionId}`}
      href={
        extension === undefined
          ? undefined
          : `/extensions/${encodeURIComponent(extensionId)}`
      }
      pageTitle={extension?.displayName ?? extensionId}
      hasChildItems={owned.length > 0}
      chevronPosition="trailing"
      icon={
        extension?.icon === undefined
          ? Apps
          : (icons.get(extension.icon) ?? Apps)
      }
      trailing={
        extension === undefined ? (
          <Text size="xs" color="lowContrast">
            Not running
          </Text>
        ) : extension.publishing === undefined ? undefined : apps.data?.some(
            (app) =>
              app.extensionId === extensionId &&
              app.stage !== "live" &&
              app.publishFailure !== undefined,
          ) ? (
          <span title="Publishing failed">
            <WarningTriangle size="sm" aria-label="Publishing failed" />
          </span>
        ) : (
          <Text size="xs" color="lowContrast">
            Publishing…
          </Text>
        )
      }
      items={owned.map((automation) => (
        <SidebarItem
          key={automation.id}
          id={
            idPrefix === ""
              ? `automation:${automation.id}`
              : `${id}/automation:${automation.id}`
          }
          favoriteId={`automation:${automation.id}`}
          href={`/automations/${encodeURIComponent(automation.id)}`}
          pageTitle={automation.name}
          icon={Clock}
        >
          {automation.name}
        </SidebarItem>
      ))}
    >
      {extension?.displayName ?? extensionId}
    </SidebarItem>
  );
}
