import { Button, Text, Tooltip } from "maui";
import { CalendarTimer, Bolt, Plus } from "maui/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../api/ApiProvider.js";
import { useDatabaseQuery } from "../database/useDatabaseQuery.js";
import { sessionTitleQueryKey } from "../main/agent/useAgentSession.js";
import { useWorkspacePanes } from "../panes/WorkspacePanesProvider.js";
import { useSidebar } from "../WorkspaceLayout.js";
import { SidebarEmptyState } from "./SidebarEmptyState.js";
import { SidebarItem } from "./navigation/SidebarItem.js";
import { SidebarSection } from "./navigation/SidebarSection.js";

export function AutomationsSection() {
  const api = useApi();
  const queryClient = useQueryClient();
  const workspace = useWorkspacePanes();
  const sidebar = useSidebar();
  const automations = useDatabaseQuery({
    collection: "automations",
    orderBy: { createdAt: "asc", id: "asc" },
  })?.filter((automation) => automation.extensionId === undefined);
  const introduction = useMutation({
    mutationFn: async () => {
      const prompt = "What can Halo automations do?";
      const { sessionId } = await api.thread.new();
      queryClient.setQueryData(sessionTitleQueryKey(sessionId), prompt);
      workspace.open({ path: `/sessions/${sessionId}`, newTab: true });
      sidebar.close();
      await api.thread.prompt({ sessionId, text: prompt });
    },
  });

  return (
    <SidebarSection
      label={
        <span>
          Automations
          {introduction.error !== null && (
            <Text size="2xs" color="lowContrast" role="alert">
              {" — "}
              {introduction.error.message}
            </Text>
          )}
        </span>
      }
      actions={
        <Tooltip content="New automation">
          <Button
            variant="quiet"
            aria-label="New automation"
            isDisabled={introduction.isPending}
            onPress={() => introduction.mutate()}
          >
            <Plus size="sm" />
          </Button>
        </Tooltip>
      }
    >
      {automations?.length === 0 && <SidebarEmptyState kind="automations" />}
      {automations?.map((automation) => (
        <SidebarItem
          key={automation.id}
          id={`automation:${automation.id}`}
          href={`/automations/${encodeURIComponent(automation.id)}`}
          pageTitle={automation.name}
          icon={automation.activation.type === "routine" ? CalendarTimer : Bolt}
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
    </SidebarSection>
  );
}
