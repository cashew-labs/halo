import { Text } from "maui";
import * as MauiIcons from "maui/icons";

import { useExtensions } from "../api/WorkspaceUpdatesProvider.js";
import { SidebarItem } from "./navigation/SidebarItem.js";
import { SidebarSection } from "./navigation/SidebarSection.js";

const icons = new Map(Object.entries(MauiIcons));

export function ExtensionsSection() {
  const extensions = useExtensions();

  if (
    extensions.error === undefined &&
    (extensions.data === undefined || extensions.data.length === 0)
  )
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
      {extensions.data?.map((extension) => (
        <SidebarItem
          key={extension.id}
          id={`extension:${extension.id}`}
          href={`/extensions/${encodeURIComponent(extension.id)}`}
          pageTitle={extension.displayName}
          icon={
            extension.icon === undefined ? undefined : icons.get(extension.icon)
          }
        >
          {extension.displayName}
        </SidebarItem>
      ))}
    </SidebarSection>
  );
}
