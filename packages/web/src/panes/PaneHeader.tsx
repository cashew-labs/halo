import { createContext, useCallback, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePaneStyles } from "./paneStyles.js";

/** The active tab's header action container; unset for hidden tabs and standalone views. */
export const PaneHeaderSlot = createContext<HTMLElement | undefined>(undefined);

/** Shows a pane's active tab title, with room for that tab's actions. */
export function PaneHeader({
  paneId,
  title,
  onActionsSlot,
}: {
  paneId: string;
  title: string;
  onActionsSlot(paneId: string, element: HTMLElement | null): void;
}) {
  const chrome = usePaneStyles();
  const actionsRef = useCallback(
    (element: HTMLDivElement | null) => onActionsSlot(paneId, element),
    [paneId, onActionsSlot],
  );
  return (
    <header className={chrome.header} data-testid="pane-header">
      <h2 className={chrome.headerTitle} title={title}>
        {title}
      </h2>
      <div ref={actionsRef} className={chrome.headerActions} />
    </header>
  );
}

/** Renders a pane's actions in its header while its tab is active. */
export function PaneHeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(PaneHeaderSlot);
  return slot && createPortal(children, slot);
}
