import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import {
  Button,
  Select,
  SelectItem,
  backgroundColor,
  flex,
  radius,
  shadow,
  spacing,
  text,
} from "maui";
import { style, useStyles } from "purse-styles";

export type FileEntryAction =
  | { kind: "delete"; path: string; isDirectory: boolean }
  | { kind: "move"; path: string; isDirectory: boolean };

export function FileEntryDialog({
  action,
  folders,
  pending,
  error,
  onSubmit,
  onBrowseFolder,
  onClose,
}: {
  action: FileEntryAction;
  folders: string[];
  pending: boolean;
  error: string | undefined;
  onSubmit(path: string): void;
  onBrowseFolder(path: string): void;
  onClose(): void;
}) {
  const originalName = action.path.slice(action.path.lastIndexOf("/") + 1);
  const [folder, setFolder] = useState(
    action.path.slice(0, Math.max(0, action.path.lastIndexOf("/"))),
  );
  const overlay = useStyles(styles.overlay);
  const modal = useStyles(styles.modal);
  const form = useStyles(styles.form);
  const heading = useStyles(styles.heading);
  const buttons = useStyles(styles.buttons);
  const errorClass = useStyles(styles.error);
  const title =
    action.kind === "delete"
      ? `Delete ${originalName}?`
      : `Move ${originalName}`;
  const destination =
    folder === "" ? originalName : `${folder}/${originalName}`;
  const unchanged = action.kind === "move" && destination === action.path;
  const availableFolders = folders.filter(
    (path) =>
      !action.isDirectory ||
      (path !== action.path && !path.startsWith(`${action.path}/`)),
  );

  return (
    <ModalOverlay
      isOpen
      isDismissable={!pending}
      isKeyboardDismissDisabled={pending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className={overlay}
    >
      <Modal className={modal}>
        <Dialog aria-label={title}>
          <form
            className={form}
            onSubmit={(event) => {
              event.preventDefault();
              if (!unchanged && !pending)
                onSubmit(action.kind === "delete" ? action.path : destination);
            }}
          >
            <h2 className={heading}>{title}</h2>
            {action.kind === "delete" && (
              <p>
                This permanently deletes{" "}
                {action.isDirectory
                  ? "this folder and everything inside it"
                  : "this file"}
                . This cannot be undone.
              </p>
            )}
            {action.kind === "move" && (
              <Select
                label="Move to"
                selectedKey={folder === "" ? "/" : folder}
                onSelectionChange={(key) => {
                  if (key === null) return;
                  const path = key === "/" ? "" : String(key);
                  setFolder(path);
                  onBrowseFolder(path);
                }}
                isDisabled={pending}
                autoFocus
              >
                {availableFolders.map((path) => (
                  <SelectItem key={path} id={path === "" ? "/" : path}>
                    {path === "" ? "Workspace" : path}
                  </SelectItem>
                ))}
              </Select>
            )}
            {error !== undefined && (
              <div role="alert" className={errorClass}>
                {error}
              </div>
            )}
            <div className={buttons}>
              <Button type="button" onClick={onClose} isDisabled={pending}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                isDisabled={unchanged || pending}
              >
                {pending
                  ? action.kind === "delete"
                    ? "Deleting…"
                    : "Saving…"
                  : action.kind === "delete"
                    ? "Delete"
                    : "Move"}
              </Button>
            </div>
          </form>
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
    display: "grid",
    placeItems: "center",
    padding: "24px",
  }),
  modal: style(shadow.strong, radius.lg, spacing.padding({ all: 8 }), {
    width: "min(420px, 100%)",
    backgroundColor: backgroundColor.app,
    "& [role='dialog']": { outline: "none" },
  }),
  form: style(flex({ direction: "column", gap: 6 })),
  heading: style(text({ size: "md", fontWeight: 600 }), {
    margin: 0,
    overflowWrap: "anywhere",
  }),
  buttons: style(flex({ justifyContent: "end", gap: 3 }), {
    marginTop: spacing.value(2),
    "& button": { transition: "none" },
  }),
  error: style(text({ size: "sm" }), {
    color: "light-dark(#b42318, #ff9592)",
    overflowWrap: "anywhere",
  }),
};
