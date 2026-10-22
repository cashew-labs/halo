import type { ThreadSummary } from "@get-halo/client";
import { useMutation } from "@tanstack/react-query";
import { Button, Tooltip } from "maui";
import { Check } from "maui/icons";
import { useApi } from "../../api/ApiProvider.js";

/** Toggles whether a thread is done; done threads leave the sidebar. */
export function DoneButton({ thread }: { thread: ThreadSummary }) {
  const api = useApi();
  const toggle = useMutation({
    mutationKey: ["thread-done", thread.sessionId],
    mutationFn: async (done: boolean) =>
      done
        ? await api.thread.markDone({ sessionId: thread.sessionId })
        : await api.thread.markUndone({ sessionId: thread.sessionId }),
  });
  return (
    <Tooltip
      content={thread.markedDone ? "Mark not done" : "Mark done"}
      placement="bottom"
    >
      <Button
        variant="quiet"
        aria-label="Done"
        aria-pressed={thread.markedDone}
        isDisabled={toggle.isPending}
        onPress={() => toggle.mutate(!thread.markedDone)}
      >
        <Check size="sm" />
      </Button>
    </Tooltip>
  );
}
