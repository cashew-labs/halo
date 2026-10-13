import { SessionActivity } from "./SessionActivity.js";
import type { SessionSummary } from "@get-halo/client";
import { useMutation } from "@tanstack/react-query";
import { Button, Tooltip } from "maui";
import { Check, Plus } from "maui/icons";
import { useApi } from "../api/ApiProvider.js";
import { useWorkspacePanes } from "../panes/WorkspacePanesProvider.js";
import { useSidebar } from "../WorkspaceLayout.js";
import { SidebarEmptyState } from "./SidebarEmptyState.js";
import { SidebarItem } from "./navigation/SidebarItem.js";
import { SidebarSection } from "./navigation/SidebarSection.js";

export function SessionsSection({ sessions }: { sessions: SessionSummary[] }) {
  const workspace = useWorkspacePanes();
  const sidebar = useSidebar();
  const visibleSessions = sessions.filter((session) => !isDone(session));
  return (
    <SidebarSection
      label="Sessions"
      actions={
        <Tooltip content="New session">
          <Button
            variant="quiet"
            aria-label="New session"
            onPress={() => {
              workspace.open({
                path: `/draft/${crypto.randomUUID()}`,
                newTab: true,
              });
              sidebar.close();
            }}
          >
            <Plus size="sm" />
          </Button>
        </Tooltip>
      }
    >
      {visibleSessions.length === 0 && <SidebarEmptyState kind="sessions" />}
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
      await api.thread.markDone({ sessionId: session.sessionId }),
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
          size="sm"
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
