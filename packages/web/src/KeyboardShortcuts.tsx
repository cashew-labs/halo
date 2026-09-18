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
import { useLocation } from "wouter";
import { useHost } from "./HostProvider.js";
import { shortcuts } from "./shortcuts.js";

export function KeyboardShortcuts() {
  const host = useHost();
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const overlay = useStyles(styles.overlay);
  const modal = useStyles(styles.modal);
  const heading = useStyles(styles.heading);
  const row = useStyles(styles.row);
  const hint = useStyles(styles.hint);
  const modifier = navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+";

  const newChat = useCallback(() => {
    setOpen(false);
    navigate(`/draft/${crypto.randomUUID()}`);
  }, [navigate]);

  useEffect(
    () =>
      host.onShortcut?.((shortcut) => {
        if (shortcut === "newChat") {
          newChat();
          return;
        }
        setOpen((value) => !value);
      }),
    [newChat, host],
  );

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
            onAction={(key) => {
              if (key === "newChat") {
                newChat();
                return;
              }
              setOpen(false);
            }}
          >
            {Object.entries(shortcuts).map(([id, shortcut]) => (
              <MenuItem id={id} key={id} textValue={shortcut.label}>
                <span className={row}>
                  <span>{shortcut.label}</span>
                  <Kbd>{modifier + shortcut.key}</Kbd>
                </span>
              </MenuItem>
            ))}
          </Menu>
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
    backgroundColor: backgroundColor.app,
    "& [role='dialog'], & [role='menu']": { outline: "none" },
    "& [role='menuitem']": { transition: "none" },
  }),
  heading: style(
    text({ size: "sm", fontWeight: 600, color: "highContrast" }),
    spacing.padding({ all: 4 }),
    { margin: 0 },
  ),
  row: style(flex({ align: "center", justify: "between", gap: 8 }), {
    width: "100%",
    minHeight: "28px",
  }),
  hint: style(
    text({ size: "xs", color: "lowContrast" }),
    spacing.padding({ all: 4 }),
    { margin: 0 },
  ),
};
