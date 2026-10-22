import { ThreadActivity } from "./ThreadActivity.js";
import type { ThreadSummary } from "@get-halo/client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "maui";
import { Check } from "maui/icons";
import { useApi } from "../api/ApiProvider.js";
import { SidebarEmptyState } from "./SidebarEmptyState.js";
import { SidebarItem } from "./navigation/SidebarItem.js";
import { SidebarSection } from "./navigation/SidebarSection.js";

export function ThreadsSection({ threads }: { threads: ThreadSummary[] }) {
  const visibleThreads = threads.filter((thread) => !isDone(thread));
  return (
    <SidebarSection sectionId="sessions" label="Threads">
      {visibleThreads.length === 0 && <SidebarEmptyState kind="threads" />}
      {visibleThreads.map((thread) => (
        <ThreadRow key={thread.sessionId} thread={thread} />
      ))}
    </SidebarSection>
  );
}

function ThreadRow({ thread }: { thread: ThreadSummary }) {
  const api = useApi();
  const mutation = useMutation({
    mutationKey: ["thread-done", thread.sessionId],
    mutationFn: async () =>
      await api.thread.markDone({ sessionId: thread.sessionId }),
  });
  const title = thread.title ? thread.title : thread.sessionId;
  return (
    <SidebarItem
      id={`session:${thread.sessionId}`}
      href={`/sessions/${thread.sessionId}`}
      pageTitle={title}
      leading={<ThreadActivity thread={thread} />}
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

function isDone(thread: ThreadSummary) {
  return thread.markedDone;
}
