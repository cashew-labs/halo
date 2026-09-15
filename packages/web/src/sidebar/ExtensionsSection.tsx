import { Text } from "maui";
import * as MauiIcons from "maui/icons";

import { useExtensionsQuery, useWorkspaceQuery } from "../api/ApiProvider.tsx";
import { SidebarItem } from "./navigation/SidebarItem.js";
import { SidebarSection } from "./navigation/SidebarSection.js";

const icons = new Map(Object.entries(MauiIcons));

export function ExtensionsSection() {
  const workspace = useWorkspaceQuery().data;
  const extensions = useExtensionsQuery(workspace);

  if (extensions.isError) {
    return (
      <SidebarSection label="Extensions">
        <Text role="alert">{extensions.error.message}</Text>
      </SidebarSection>
    );
  }
  if (extensions.data === undefined || extensions.data.length === 0)
    return undefined;

  return (
    <SidebarSection label="Extensions">
      {extensions.data.map((extension) => (
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
