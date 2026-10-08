import { Text } from "maui";
import { CalendarTimer, Bolt, Plus } from "maui/icons";
import { useAutomations } from "../api/WorkspaceUpdatesProvider.js";
import { SidebarItem } from "./navigation/SidebarItem.js";
import { SidebarSection } from "./navigation/SidebarSection.js";

export function AutomationsSection() {
  const automations = useAutomations()?.filter(
    (automation) => automation.extensionId === undefined,
  );

  return (
    <SidebarSection label="Automations">
      <SidebarItem
        id="automations"
        href="/automations"
        pageTitle="Automations"
        icon={Plus}
      >
        All automations
      </SidebarItem>
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
