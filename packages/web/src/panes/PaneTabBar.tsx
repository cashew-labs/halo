import { useRef } from "react";
import { TabBar, type TabBarProps } from "maui";
import { paneTabDragType } from "./paneDrag.js";
import { usePaneStyles } from "./paneStyles.js";

export function PaneTabBar(props: TabBarProps) {
  const chrome = usePaneStyles();
  const dragTabId = useRef<string | undefined>(undefined);

  return (
    <div
      className={chrome.tabs}
      draggable
      onPointerDownCapture={(event) => {
        // Maui owns the buttons; its TabBar has no per-item drag props.
        dragTabId.current = undefined;
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest("button[aria-pressed]");
        if (button === null) return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll("button[aria-pressed]"),
        );
        dragTabId.current = props.items[buttons.indexOf(button)]?.id;
      }}
      onDragStart={(event) => {
        if (dragTabId.current === undefined) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.setData(paneTabDragType, dragTabId.current);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {
        dragTabId.current = undefined;
      }}
    >
      <TabBar {...props} className={chrome.nativeTabBar} />
    </div>
  );
}
