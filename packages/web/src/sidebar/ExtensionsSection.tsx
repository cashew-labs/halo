import { useEffect, useEffectEvent } from "react";
import { Text } from "maui";
import * as MauiIcons from "maui/icons";
import { CalendarTimer, Puzzle, Bolt } from "maui/icons";
import { useLocation } from "wouter";

import {
  useExtensions,
  useAutomations,
} from "../api/WorkspaceUpdatesProvider.js";
import { useExpandSidebar } from "./navigation/NavigationSidebar.js";
import { SidebarItem } from "./navigation/SidebarItem.js";
import { SidebarSection } from "./navigation/SidebarSection.js";

const icons = new Map(Object.entries(MauiIcons));

export function ExtensionsSection() {
  const extensions = useExtensions();
  const automations = useAutomations();
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
        const owned = (automations ?? []).filter(
          (automation) => automation.extensionId === extensionId,
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
            chevronPosition="trailing"
            icon={
              extension?.icon === undefined
                ? Puzzle
                : (icons.get(extension.icon) ?? Puzzle)
            }
            trailing={
              extension === undefined ? (
                <Text size="xs" color="lowContrast">
                  Not running
                </Text>
              ) : undefined
            }
            items={owned.map((automation) => (
              <SidebarItem
                key={automation.id}
                id={`automation:${automation.id}`}
                href={`/automations/${encodeURIComponent(automation.id)}`}
                pageTitle={automation.name}
                icon={
                  automation.activation.type === "routine"
                    ? CalendarTimer
                    : Bolt
                }
                trailing={
                  automation.enabled ? undefined : (
                    <Text size="xs" color="lowContrast">
                      Paused
                    </Text>
                  )
                }
              >
                {automation.name}
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
