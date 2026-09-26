import { SessionActivity } from "./SessionActivity.js";
import type { SessionSummary } from "@get-halo/client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "maui";
import { Check } from "maui/icons";
import { useApi } from "../api/ApiProvider.js";
import { SidebarItem } from "./navigation/SidebarItem.js";
import { SidebarSection } from "./navigation/SidebarSection.js";

export function SessionsSection({ sessions }: { sessions: SessionSummary[] }) {
  const visibleSessions = sessions.filter((session) => !isDone(session));
  if (visibleSessions.length === 0) return undefined;
  return (
    <SidebarSection label="Sessions">
      {visibleSessions.map((session) => (
        <SessionRow key={session.sessionId} session={session} />
      ))}
    </SidebarSection>
  );
}

function SessionRow({ session }: { session: SessionSummary }) {
  const api = useApi();
  const mutation = useMutation({
    mutationKey: ["thread-done", session.sessionId],
    mutationFn: async () =>
      await api.sessions.markDone({ sessionId: session.sessionId }),
  });
  const title = session.title ? session.title : session.sessionId;
  return (
    <SidebarItem
      id={`session:${session.sessionId}`}
      href={`/sessions/${session.sessionId}`}
      pageTitle={title}
      leading={<SessionActivity session={session} />}
      hoverTrailing={
        <Button
          variant="quiet"
          aria-label="Mark done"
          isDisabled={mutation.isPending}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            mutation.mutate();
          }}
        >
          <Check size="sm" />
        </Button>
      }
    >
      {title}
    </SidebarItem>
  );
}

function isDone(session: SessionSummary) {
  return session.markedDone;
}
