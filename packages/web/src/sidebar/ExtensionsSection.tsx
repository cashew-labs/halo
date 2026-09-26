import { useEffect, useEffectEvent } from "react";
import { Text } from "maui";
import * as MauiIcons from "maui/icons";
import { CalendarTimer } from "maui/icons";
import { useLocation } from "wouter";

import { useExtensions, useRoutines } from "../api/WorkspaceUpdatesProvider.js";
import { useExpandSidebar } from "./navigation/NavigationSidebar.js";
import { SidebarItem } from "./navigation/SidebarItem.js";
import { SidebarSection } from "./navigation/SidebarSection.js";

const icons = new Map(Object.entries(MauiIcons));

export function ExtensionsSection() {
  const extensions = useExtensions();
  const routines = useRoutines();
  const expand = useExpandSidebar();
  const [location] = useLocation();
  // Extensions with routines stay listed while their process is not running.
  const extensionIds = [
    ...new Set([
      ...(extensions.data ?? []).map((extension) => extension.id),
      ...(routines ?? []).map((routine) => routine.extensionId),
    ]),
  ];
  const openExtensionId = routines?.find(
    (routine) => location === `/routines/${encodeURIComponent(routine.id)}`,
  )?.extensionId;
  const expandExtension = useEffectEvent((extensionId: string) =>
    expand([`extension:${extensionId}`]),
  );

  // Reveal the open routine under its extension.
  useEffect(() => {
    if (openExtensionId !== undefined) expandExtension(openExtensionId);
  }, [openExtensionId]);

  if (extensions.error === undefined && extensionIds.length === 0)
    return undefined;

  return (
    <SidebarSection
      label={
        <>
          Extensions
          {extensions.error !== undefined && (
            <Text size="xs" role="alert">
              : {extensions.error.message}
            </Text>
          )}
        </>
      }
    >
      {extensionIds.map((extensionId) => {
        const extension = extensions.data?.find(
          (item) => item.id === extensionId,
        );
        const owned = (routines ?? []).filter(
          (routine) => routine.extensionId === extensionId,
        );
        return (
          <SidebarItem
            key={extensionId}
            id={`extension:${extensionId}`}
            href={
              extension === undefined
                ? undefined
                : `/extensions/${encodeURIComponent(extensionId)}`
            }
            pageTitle={extension?.displayName ?? extensionId}
            hasChildItems={owned.length > 0}
            icon={
              extension?.icon === undefined
                ? undefined
                : icons.get(extension.icon)
            }
            trailing={
              extension === undefined ? (
                <Text size="xs" color="lowContrast">
                  Not running
                </Text>
              ) : undefined
            }
            items={owned.map((routine) => (
              <SidebarItem
                key={routine.id}
                id={`routine:${routine.id}`}
                href={`/routines/${encodeURIComponent(routine.id)}`}
                pageTitle={routine.name}
                icon={CalendarTimer}
                trailing={
                  routine.enabled ? undefined : (
                    <Text size="xs" color="lowContrast">
                      Paused
                    </Text>
                  )
                }
              >
                {routine.name}
              </SidebarItem>
            ))}
          >
            {extension?.displayName ?? extensionId}
          </SidebarItem>
        );
      })}
    </SidebarSection>
  );
}
