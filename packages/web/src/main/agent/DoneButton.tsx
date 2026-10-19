import type { SessionSummary } from "@get-halo/client";
import { useMutation } from "@tanstack/react-query";
import { Button, Tooltip } from "maui";
import { Check } from "maui/icons";
import { useApi } from "../../api/ApiProvider.js";

/** Toggles whether a session is done; done sessions leave the sidebar. */
export function DoneButton({ session }: { session: SessionSummary }) {
  const api = useApi();
  const toggle = useMutation({
    mutationKey: ["thread-done", session.sessionId],
    mutationFn: async (done: boolean) =>
      done
        ? await api.thread.markDone({ sessionId: session.sessionId })
        : await api.thread.markUndone({ sessionId: session.sessionId }),
  });
  return (
    <Tooltip
      content={session.markedDone ? "Mark not done" : "Mark done"}
      placement="bottom"
    >
      <Button
        variant="quiet"
        aria-label="Done"
        aria-pressed={session.markedDone}
        isDisabled={toggle.isPending}
        onPress={() => toggle.mutate(!session.markedDone)}
      >
        <Check size="sm" />
      </Button>
    </Tooltip>
  );
}
