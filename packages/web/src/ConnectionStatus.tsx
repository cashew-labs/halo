import { useState, type ReactNode } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import {
  Button,
  Flex,
  H3,
  P,
  backgroundColor,
  colors,
  focusRing,
  radius,
  shadow,
  spacing,
  text,
  Tooltip,
  visuallyHidden,
} from "maui";
import { style, useStyles } from "purse-styles";
import { IncompatibleServerError } from "@get-halo/client";
import { useConnection } from "./api/ConnectionContext.js";
import { IncompatibleConnection } from "./ConnectionPage.js";
import { useReauthenticate } from "./Authentication.js";

/** The sidebar's connection dot. Its label is the tooltip. */
export function ConnectionStatus() {
  const { state } = useConnection();
  const asleep =
    state.power === "asleep" &&
    state.status !== "authentication" &&
    state.status !== "offline" &&
    state.status !== "incompatible";
  const statusClass = useStyles(statusStyle);
  const hiddenLabel = useStyles(visuallyHidden);
  const mismatch =
    state.error instanceof IncompatibleServerError ? state.error : undefined;
  const label = (() => {
    if (mismatch !== undefined) {
      const { supportedProtocols, clientProtocolVersion } = mismatch;
      if (
        supportedProtocols.every(
          (version) => version > Number(clientProtocolVersion),
        )
      )
        return "App update required";
      if (
        supportedProtocols.every(
          (version) => version < Number(clientProtocolVersion),
        )
      )
        return "Server update required";
      return "Unsupported API protocol";
    }
    if (state.status === "offline") return "Disconnected";
    if (state.status === "authentication") return "Sign in required";
    if (state.power === "sleeping") return "Sleeping…";
    if (state.power === "asleep") return "Asleep";
    if (state.power === "waking") return "Waking…";
    if (state.status === "connected") return "Connected";
    if (state.api === undefined && state.status !== "reconnecting")
      return "Connecting…";
    return "Reconnecting…";
  })();
  const color = (() => {
    if (asleep) return colors.blue[12];
    if (label === "Connected") return colors.green[9];
    return colors.amber[9];
  })();
  // The hidden label stays in the live region so screen readers announce changes.
  const indicator = (
    <>
      <span aria-hidden="true" style={{ color }}>
        ●
      </span>
      <span className={hiddenLabel}>{label}</span>
    </>
  );
  if (state.status !== "authentication" && mismatch === undefined)
    return (
      <Tooltip content={label} placement="top">
        <span
          className={statusClass}
          role="status"
          aria-live="polite"
          aria-label={`Connection: ${label}`}
          tabIndex={0}
        >
          {indicator}
        </span>
      </Tooltip>
    );
  return (
    <ConnectionAction label={label} mismatch={mismatch} className={statusClass}>
      {indicator}
    </ConnectionAction>
  );
}

function ConnectionAction({
  label,
  mismatch,
  className,
  children,
}: {
  label: string;
  mismatch: IncompatibleServerError | undefined;
  className: string;
  children: ReactNode;
}) {
  const { service, state } = useConnection();
  const reauthenticate = useReauthenticate();
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [signingIn, setSigningIn] = useState(false);
  const overlay = useStyles(overlayStyle);
  const modal = useStyles(modalStyle);
  const details = useStyles(detailsStyle);
  return (
    <>
      {/* Tooltip needs a single focusable child, not this fragment. */}
      <Tooltip content={label} placement="top">
        <Button
          variant="quiet"
          className={className}
          onClick={() => setOpen(true)}
          aria-label={`Connection: ${label}`}
        >
          {children}
        </Button>
      </Tooltip>
      <ModalOverlay
        isOpen={open}
        onOpenChange={setOpen}
        isDismissable
        className={overlay}
      >
        <Modal className={modal}>
          <Dialog aria-label={label}>
            <Flex column gap={4}>
              <H3>{label}</H3>
              {mismatch !== undefined ? (
                <IncompatibleConnection error={mismatch} />
              ) : (
                <P>
                  {state.error?.message ??
                    "Sign in to reconnect your workspace."}
                </P>
              )}
              {actionError !== undefined && (
                <div role="alert">
                  <P>{actionError}</P>
                </div>
              )}
              <details>
                <summary>Connection details</summary>
                <pre className={details}>
                  {JSON.stringify(service.diagnostics(), undefined, 2)}
                </pre>
                <Button
                  onClick={async () => {
                    await navigator.clipboard
                      .writeText(
                        JSON.stringify(service.diagnostics(), undefined, 2),
                      )
                      .catch(() =>
                        setActionError(
                          "Could not copy details. Select and copy the text above.",
                        ),
                      );
                  }}
                >
                  Copy details
                </Button>
              </details>
              <Flex row gap={3}>
                {state.status === "authentication" ? (
                  <Button
                    isPending={signingIn}
                    onClick={async () => {
                      setSigningIn(true);
                      setActionError(undefined);
                      const result = await reauthenticate();
                      setSigningIn(false);
                      if (result instanceof Error) {
                        setActionError(result.message);
                        return;
                      }
                      if (!result) return;
                      setOpen(false);
                      service.resumeAfterSignIn();
                    }}
                  >
                    {signingIn ? "Waiting for sign-in…" : "Sign in"}
                  </Button>
                ) : (
                  <Button onClick={service.retry}>Retry now</Button>
                )}
                <Button variant="quiet" onClick={() => setOpen(false)}>
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
const statusStyle = style(
  text({ size: "lg", fontWeight: 400 }),
  focusRing(),
  radius.sm,
  {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    minWidth: 24,
    minHeight: 24,
  },
);
export const overlayStyle = style({
  position: "fixed",
  inset: 0,
  // The mobile sidebar drawer uses layer 1100.
  zIndex: 1200,
  backgroundColor: "rgba(0, 0, 0, 0.55)",
  backdropFilter: "blur(4px)",
  display: "grid",
  placeItems: "center",
  padding: "24px",
});
export const modalStyle = style(
  shadow.strong,
  radius.lg,
  spacing.padding({ all: 8 }),
  {
    width: "min(440px, 100%)",
    maxHeight: "calc(100dvh - 48px)",
    overflowY: "auto",
    backgroundColor: backgroundColor.app,
    overflowWrap: "anywhere",
    "& [role='dialog']": { outline: "none" },
  },
);
const detailsStyle = style({ overflowX: "auto", maxWidth: "100%" });
