import type { SessionSummary } from "@get-halo/shared/rpc";
import { SidebarItem } from "./navigation/SidebarItem.js";
import { SidebarSection } from "./navigation/SidebarSection.js";

export function SessionsSection({ sessions }: { sessions: SessionSummary[] }) {
  if (sessions.length === 0) return undefined;
  return (
    <SidebarSection label="Sessions">
      {sessions.map((session) => {
        const title = session.title ? session.title : session.sessionId;
        return (
          <SidebarItem
            key={session.sessionId}
            id={`session:${session.sessionId}`}
            href={`/sessions/${session.sessionId}`}
            pageTitle={title}
          >
            {title}
          </SidebarItem>
        );
      })}
    </SidebarSection>
  );
}
