import { Text } from "maui";
import { CalendarTimer } from "maui/icons";
import { useDatabaseQuery } from "../database/useDatabaseQuery.js";
import { SidebarItem } from "./navigation/SidebarItem.js";
import { SidebarSection } from "./navigation/SidebarSection.js";

export function ScheduledSection() {
  const routines = useDatabaseQuery({
    collection: "routines",
    orderBy: { createdAt: "asc", id: "asc" },
  })?.filter((routine) => routine.extensionId === undefined);
  if (routines === undefined || routines.length === 0) return undefined;

  return (
    <SidebarSection label="Scheduled">
      {routines.map((routine) => (
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
    </SidebarSection>
  );
}
