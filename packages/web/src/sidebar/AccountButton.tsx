import { PublisherSettings, problemStyle } from "./PublisherSettings.js";
import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { Avatar, Button, Flex, flex, spacing, text } from "maui";
import { style, useStyles } from "purse-styles";
import { useAccount } from "../Authentication.js";
import { modalStyle, overlayStyle } from "../ConnectionStatus.js";
import type { AppInfo } from "../HostApi.js";
import { useAsyncAction } from "../useAsyncAction.js";

export function AccountButton({ appInfo }: { appInfo?: AppInfo }) {
  const { session, signOut } = useAccount();
  const [open, setOpen] = useState(false);
  const [savingPublisher, setSavingPublisher] = useState(false);
  const signingOut = useAsyncAction(signOut);
  const trigger = useStyles(triggerStyle);
  const email = useStyles(emailStyle);
  const overlay = useStyles(overlayStyle);
  const modal = useStyles(modalStyle);
  const identity = useStyles(identityStyle);
  const name = useStyles(nameStyle);
  const detail = useStyles(detailStyle);
  const footer = useStyles(footerStyle);
  const signOutRow = useStyles(signOutRowStyle);
  const signOutError = useStyles(detailStyle, problemStyle, signOutErrorStyle);
  const { user } = session;
  // Google profile images are not loaded: the web app's CSP allows only
  // Halo-hosted images, so both hosts show initials.
  return (
    <>
      <Button
        variant="quiet"
        className={trigger}
        aria-label={`Account: ${user.email}`}
        data-testid="account-button"
        onClick={() => setOpen(true)}
      >
        <Avatar name={user.name} size="lg" />
        <span className={email}>{user.email}</span>
      </Button>
      <ModalOverlay
        isOpen={open}
        onOpenChange={setOpen}
        isDismissable={!signingOut.pending && !savingPublisher}
        isKeyboardDismissDisabled={signingOut.pending || savingPublisher}
        className={overlay}
      >
        <Modal className={modal}>
          <Dialog aria-label="Account">
            <Flex column gap={8}>
              <div className={identity}>
                <Avatar name={user.name} size="lg" />
                <Flex column gap={1}>
                  <span className={name}>{user.name}</span>
                  {user.email !== user.name && (
                    <span className={detail}>{user.email}</span>
                  )}
                </Flex>
              </div>
              {open && <PublisherSettings onSaving={setSavingPublisher} />}
              <div className={footer}>
                {appInfo !== undefined && (
                  <span className={detail} data-testid="app-version">
                    {appInfo.development
                      ? "Development build"
                      : `Version ${appInfo.version}`}
                  </span>
                )}
                <div className={signOutRow}>
                  {signingOut.error !== undefined && (
                    <span role="alert" className={signOutError}>
                      {signingOut.error.message}
                    </span>
                  )}
                  <Button
                    isPending={signingOut.pending}
                    isDisabled={savingPublisher}
                    onClick={() => void signingOut.run()}
                  >
                    {signingOut.pending ? "Signing out…" : "Sign out"}
                  </Button>
                </div>
              </div>
            </Flex>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}

const triggerStyle = style(text({ size: "xs", color: "lowContrast" }), {
  justifyContent: "flex-start",
  gap: spacing.value(3),
  flex: 1,
  minWidth: 0,
  minHeight: 24,
  height: "auto",
  padding: 0,
});
const emailStyle = style({
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
const identityStyle = style({
  display: "flex",
  alignItems: "center",
  gap: spacing.value(4),
  minWidth: 0,
});
const nameStyle = style(text({ size: "sm", fontWeight: 600 }));
const detailStyle = style(text({ size: "xs", color: "lowContrast" }));
const footerStyle = style(
  flex({ alignItems: "center", justifyContent: "between", gap: 4 }),
);
const signOutRowStyle = style(flex({ alignItems: "center", gap: 4 }), {
  marginLeft: "auto",
});
const signOutErrorStyle = style({ textAlign: "right" });
