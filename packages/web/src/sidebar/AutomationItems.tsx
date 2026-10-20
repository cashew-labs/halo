import { Clock } from "maui/icons";
import { useDatabaseQuery } from "../database/useDatabaseQuery.js";
import { SidebarItem } from "./navigation/SidebarItem.js";

// Lists automations that no extension owns, or every automation when requested.
export function AutomationItems({
  includeExtensions,
}: {
  includeExtensions: boolean;
}) {
  const automations = useDatabaseQuery({
    collection: "automations",
    orderBy: { createdAt: "asc", id: "asc" },
  })?.filter(
    (automation) => includeExtensions || automation.extensionId === undefined,
  );
  return automations?.map((automation) => (
    <SidebarItem
      key={automation.id}
      id={`automation:${automation.id}`}
      href={`/automations/${encodeURIComponent(automation.id)}`}
      pageTitle={automation.name}
      icon={Clock}
    >
      {automation.name}
    </SidebarItem>
  ));
}
