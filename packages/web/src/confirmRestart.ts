import { useEffect } from "react";

const beforeRestart = "halo:before-restart";

export function useRestartWarning(unsaved: boolean) {
  useEffect(() => {
    if (!unsaved) return;
    const preventRestart = (event: Event) => event.preventDefault();
    window.addEventListener(beforeRestart, preventRestart);
    return () => window.removeEventListener(beforeRestart, preventRestart);
  }, [unsaved]);
}

export function confirmRestart() {
  const safe = window.dispatchEvent(
    new Event(beforeRestart, { cancelable: true }),
  );
  return (
    safe ||
    window.confirm(
      "You have unsaved edits or message drafts. Cancel to copy them before restarting, or continue and discard them.",
    )
  );
}
