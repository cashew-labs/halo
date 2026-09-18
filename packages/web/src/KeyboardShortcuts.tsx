import { useCallback, useEffect, useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import {
  Kbd,
  Menu,
  MenuItem,
  backgroundColor,
  flex,
  radius,
  shadow,
  spacing,
  text,
} from "maui";
import { style, useStyles } from "purse-styles";
import { useHost } from "./HostProvider.js";
import { useWorkspacePanes } from "./panes/WorkspacePanesProvider.js";
import { shortcuts } from "./shortcuts.js";
import { matchesHotkey, type HotkeyAction } from "@get-halo/client";
import { useHotkeys } from "./useHotkeys.js";

export function KeyboardShortcuts() {
  const host = useHost();
  const workspace = useWorkspacePanes();
  const [open, setOpen] = useState(false);
  const hotkeys = useHotkeys();
  const overlay = useStyles(styles.overlay);
  const modal = useStyles(styles.modal);
  const heading = useStyles(styles.heading);
  const row = useStyles(styles.row);
  const hint = useStyles(styles.hint);
  const isMac = navigator.platform.startsWith("Mac");
  const modifier = isMac ? "⌘" : "Ctrl+";

  const runAction = useCallback(
    (action: HotkeyAction) => {
      if (action.type === "shortcutMenu") {
        setOpen((value) => !value);
        return;
      }
      setOpen(false);
      if (action.type === "closeTab") {
        workspace.close(workspace.activePane().activeTabId);
        return;
      }
      if (action.type === "openFile") {
        workspace.open({
          path: `/files/${action.path.split("/").map(encodeURIComponent).join("/")}`,
          newTab: true,
        });
        return;
      }
      if (action.type === "openExtension") {
        workspace.open({
          path: `/extensions/${encodeURIComponent(action.id)}`,
          newTab: true,
        });
        return;
      }
      workspace.open({
        path: `/draft/${crypto.randomUUID()}`,
        newTab: action.type === "newTab",
      });
    },
    [workspace],
  );

  const runShortcut = useCallback(
    (id: string) => {
      if (id === "newTab" || id === "newChat" || id === "shortcutMenu") {
        runAction({ type: id });
        return;
      }
      const hotkey = hotkeys.find((item) => `custom:${item.id}` === id);
      if (hotkey !== undefined) runAction(hotkey.action);
    },
    [hotkeys, runAction],
  );

  useEffect(() => host.onShortcut?.(runShortcut), [host, runShortcut]);
  useEffect(() => {
    host.setHotkeys?.(hotkeys);
    return () => host.setHotkeys?.([]);
  }, [host, hotkeys]);
  useEffect(() => {
    // Electron handles keys before editors and extension frames. Browsers use DOM events.
    if (host.onShortcut !== undefined) return;
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || event.getModifierState("AltGraph")) return;
      const matches = (accelerator: string) =>
        matchesHotkey({
          accelerator,
          key: event.key,
          code: event.code,
          meta: event.metaKey,
          control: event.ctrlKey,
          shift: event.shiftKey,
          alt: event.altKey,
          isMac: navigator.platform.startsWith("Mac"),
        });
      const builtin = Object.entries(shortcuts).find(([, shortcut]) =>
        matches(shortcut.accelerator),
      );
      const custom = hotkeys.find((hotkey) => matches(hotkey.accelerator));
      if (builtin === undefined && custom === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (custom !== undefined) {
        runAction(custom.action);
        return;
      }
      runShortcut(builtin![0]);
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [host, hotkeys, runAction, runShortcut]);

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={setOpen}
      isDismissable
      className={overlay}
    >
      <Modal className={modal}>
        <Dialog aria-label="Keyboard shortcuts">
          <h2 className={heading}>Keyboard shortcuts</h2>
          <Menu
            aria-label="Shortcuts"
            autoFocus="first"
            onAction={(key) => runShortcut(String(key))}
          >
            {Object.entries(shortcuts).map(([id, shortcut]) => (
              <MenuItem id={id} key={id} textValue={shortcut.label}>
                <span className={row}>
                  <span>{shortcut.label}</span>
                  <Kbd>{modifier + shortcut.key}</Kbd>
                </span>
              </MenuItem>
            ))}
            {hotkeys.map((hotkey) => (
              <MenuItem
                id={`custom:${hotkey.id}`}
                key={hotkey.id}
                textValue={hotkey.label}
              >
                <span className={row}>
                  <span>{hotkey.label}</span>
                  <Kbd>
                    {hotkey.accelerator
                      .replace("CmdOrCtrl+", modifier)
                      .replace("Shift+", isMac ? "⇧" : "Shift+")
                      .replace("Alt+", isMac ? "⌥" : "Alt+")}
                  </Kbd>
                </span>
              </MenuItem>
            ))}
          </Menu>
          <p className={hint}>
            {hotkeys.length === 0 ? "No custom hotkeys yet. " : ""}
            Ask in chat to add, change, or remove a hotkey.
          </p>
          <p className={hint}>
            ↑ ↓ to navigate · Enter to select · Esc to close
          </p>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

const styles = {
  overlay: style({
    position: "fixed",
    inset: 0,
    zIndex: 100,
    backgroundColor: "rgba(0, 0, 0, 0.35)",
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    padding: "min(20vh, 140px) 24px 24px",
  }),
  modal: style(shadow.strong, radius.lg, spacing.padding({ all: 4 }), {
    width: "min(440px, 100%)",
    maxHeight: "70dvh",
    overflowY: "auto",
    backgroundColor: backgroundColor.app,
    "& [role='dialog'], & [role='menu']": { outline: "none" },
    "& [role='menuitem']": { transition: "none" },
  }),
  heading: style(
    text({ size: "sm", fontWeight: 600, color: "highContrast" }),
    spacing.padding({ all: 4 }),
    { margin: 0 },
  ),
  row: style(
    flex({ alignItems: "center", justifyContent: "between", gap: 8 }),
    {
      width: "100%",
      minHeight: "28px",
    },
  ),
  hint: style(
    text({ size: "xs", color: "lowContrast" }),
    spacing.padding({ all: 4 }),
    { margin: 0 },
  ),
};
