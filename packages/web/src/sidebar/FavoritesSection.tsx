import type { ThreadSummary } from "@get-halo/client";
import { Text } from "maui";
import { Clock, File, Folder, Message } from "maui/icons";
import { ExtensionItem, useExtensionArtifacts } from "./ExtensionItems.js";
import { useWorkspaceDataSynced } from "../database/WorkspaceDataProvider.js";
import {
  buildFileNavigation,
  fileRoute,
  type FileNavigationNode,
} from "./FilesystemSection.js";
import { useFavoriteIds } from "./SidebarPreferencesProvider.js";
import { SidebarItem } from "./navigation/SidebarItem.js";
import { SidebarSection } from "./navigation/SidebarSection.js";
import { SidebarEmptyState } from "./SidebarEmptyState.js";

export function FavoritesSection({
  threads,
  paths,
  filesPending,
}: {
  threads: ThreadSummary[];
  paths: string[];
  filesPending: boolean;
}) {
  const favoriteIds = useFavoriteIds();
  const artifacts = useExtensionArtifacts();
  const synced = useWorkspaceDataSynced();
  const { extensions, automations } = artifacts;
  const files = buildFileNavigation(paths);
  const nodes = new Map<string, FileNavigationNode>();
  function collect(entries: FileNavigationNode[]) {
    for (const node of entries) {
      nodes.set(`file:${node.path}`, node);
      collect(node.children);
    }
  }
  collect(files);

  return (
    <SidebarSection sectionId="favorites" label="Favorites">
      {favoriteIds.length === 0 && synced && (
        <SidebarEmptyState kind="favorites" />
      )}
      {favoriteIds.map((favoriteId) => {
        if (favoriteId.startsWith("file:")) {
          const node = nodes.get(favoriteId);
          if (node !== undefined)
            return (
              <FavoriteFile key={favoriteId} rootId={favoriteId} node={node} />
            );
        }
        const thread = threads.find(
          (item) => favoriteId === `session:${item.sessionId}`,
        );
        if (thread !== undefined) {
          const title = thread.title || thread.sessionId;
          return (
            <SidebarItem
              key={favoriteId}
              id={`favorite:${favoriteId}`}
              favoriteId={favoriteId}
              href={`/sessions/${thread.sessionId}`}
              pageTitle={title}
              icon={Message}
            >
              {title}
            </SidebarItem>
          );
        }
        const automation = automations?.find(
          (item) => favoriteId === `automation:${item.id}`,
        );
        if (automation !== undefined)
          return (
            <SidebarItem
              key={favoriteId}
              id={`favorite:${favoriteId}`}
              favoriteId={favoriteId}
              href={`/automations/${encodeURIComponent(automation.id)}`}
              pageTitle={automation.name}
              icon={Clock}
            >
              {automation.name}
            </SidebarItem>
          );
        // Like Artifacts, a stopped extension stays listed through its automations.
        const extensionId = favoriteId.startsWith("extension:")
          ? favoriteId.slice("extension:".length)
          : undefined;
        if (
          extensionId !== undefined &&
          (extensions.data?.some((item) => item.id === extensionId) ||
            automations?.some((item) => item.extensionId === extensionId))
        )
          return (
            <ExtensionItem
              key={favoriteId}
              extensionId={extensionId}
              artifacts={artifacts}
              idPrefix="favorite:"
            />
          );
        const title = favoriteId
          .slice(favoriteId.indexOf(":") + 1)
          .replace(/\/$/, "")
          .split("/")
          .at(-1)!;
        const pending = favoriteId.startsWith("file:")
          ? filesPending
          : favoriteId.startsWith("automation:")
            ? !synced
            : extensionId !== undefined &&
              (!synced ||
                (extensions.data === undefined &&
                  extensions.error === undefined));
        return (
          <SidebarItem
            key={favoriteId}
            id={`favorite:${favoriteId}`}
            favoriteId={favoriteId}
            pageTitle={title}
            trailing={
              <Text size="2xs" color="lowContrast" role="status">
                {pending ? "Loading…" : "Unavailable"}
              </Text>
            }
          >
            {title}
          </SidebarItem>
        );
      })}
    </SidebarSection>
  );
}

function FavoriteFile({
  node,
  rootId,
}: {
  node: FileNavigationNode;
  rootId: string;
}) {
  return (
    <SidebarItem
      id={`favorite-file:${encodeURIComponent(rootId)}/${node.path}`}
      favoriteId={`file:${node.path}`}
      href={node.isDirectory ? undefined : fileRoute(node.path)}
      pageTitle={node.name}
      icon={node.isDirectory ? Folder : File}
      hasChildItems={node.isDirectory}
      chevronPosition="trailing"
      items={node.children.map((child) => (
        <FavoriteFile key={child.path} rootId={rootId} node={child} />
      ))}
    >
      {node.name}
    </SidebarItem>
  );
}
