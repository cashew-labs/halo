import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { Avatar, Button, Flex, H3, P, spacing, text } from "maui";
import { style, useStyles } from "purse-styles";
import { useAccount } from "../Authentication.js";
import { modalStyle, overlayStyle } from "../ConnectionStatus.js";
import type { AppInfo } from "../HostApi.js";
import { useAsyncAction } from "../useAsyncAction.js";

export function AccountButton({ appInfo }: { appInfo?: AppInfo }) {
  const { session, signOut } = useAccount();
  const [open, setOpen] = useState(false);
  const signingOut = useAsyncAction(signOut);
  const trigger = useStyles(triggerStyle);
  const email = useStyles(emailStyle);
  const overlay = useStyles(overlayStyle);
  const modal = useStyles(modalStyle);
  const identity = useStyles(identityStyle);
  const name = useStyles(nameStyle);
  const detail = useStyles(detailStyle);
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
        <Avatar name={user.name} size="xs" />
        <span className={email}>{user.email}</span>
      </Button>
      <ModalOverlay
        isOpen={open}
        onOpenChange={setOpen}
        isDismissable={!signingOut.pending}
        isKeyboardDismissDisabled={signingOut.pending}
        className={overlay}
      >
        <Modal className={modal}>
          <Dialog aria-label="Account">
            <Flex column gap={6}>
              <H3>Account</H3>
              <div className={identity}>
                <Avatar name={user.name} size="xl" />
                <Flex column gap={1}>
                  <span className={name}>{user.name}</span>
                  <span className={detail}>{user.email}</span>
                </Flex>
              </div>
              {appInfo !== undefined && (
                <P>
                  {appInfo.deployment === undefined
                    ? "Signed in with a local development identity."
                    : `Signed in to ${appInfo.deployment}.`}
                </P>
              )}
              {signingOut.error !== undefined && (
                <div role="alert">
                  <P>{signingOut.error.message}</P>
                </div>
              )}
              <Flex row gap={3}>
                <Button
                  isPending={signingOut.pending}
                  onClick={() => void signingOut.run()}
                >
                  {signingOut.pending ? "Signing out…" : "Sign out"}
                </Button>
                <Button
                  variant="quiet"
                  isDisabled={signingOut.pending}
                  onClick={() => setOpen(false)}
                >
                  Close
                </Button>
              </Flex>
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
  width: "100%",
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
