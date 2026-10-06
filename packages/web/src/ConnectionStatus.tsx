import { useState, type ReactNode } from "react";
import { Button, Dialog, Flex, H3, P, colors, text } from "maui";
import { style, useStyles } from "purse-styles";
import { IncompatibleServerError } from "@get-halo/client";
import { useConnection } from "./api/ConnectionContext.js";
import { IncompatibleConnection } from "./ConnectionPage.js";
import { useReauthenticate } from "./Authentication.js";

export function ConnectionStatus() {
  const { state } = useConnection();
  const asleep =
    state.power === "asleep" &&
    state.status !== "authentication" &&
    state.status !== "offline" &&
    state.status !== "incompatible";
  const statusClass = useStyles(statusStyle, asleep && asleepStyle);
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
  const indicator = (
    <>
      <span aria-hidden="true" style={{ color }}>
        ●
      </span>
      <span>{label}</span>
    </>
  );
  if (state.status !== "authentication" && mismatch === undefined)
    return (
      <span
        className={statusClass}
        role="status"
        aria-live="polite"
        aria-label={`Connection: ${label}`}
      >
        {indicator}
      </span>
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
  return (
    <>
      <Button
        variant="quiet"
        className={className}
        onClick={() => setOpen(true)}
        aria-label={`Connection: ${label}`}
      >
        {children}
      </Button>
      {open && (
        <Dialog onClickOutside={() => setOpen(false)}>
          <Flex column gap={4}>
            <H3>{label}</H3>
            {mismatch !== undefined ? (
              <IncompatibleConnection error={mismatch} />
            ) : (
              <P>
                {state.error?.message ?? "Sign in to reconnect your workspace."}
              </P>
            )}
            {actionError !== undefined && (
              <div role="alert">
                <P>{actionError}</P>
              </div>
            )}
            <details>
              <summary>Connection details</summary>
              <pre>{JSON.stringify(service.diagnostics(), undefined, 2)}</pre>
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
                  isDisabled={signingIn}
                  onClick={async () => {
                    setSigningIn(true);
                    const result = await reauthenticate();
                    setSigningIn(false);
                    if (result instanceof Error) {
                      setActionError(result.message);
                      return;
                    }
                    service.retry();
                  }}
                >
                  Sign in
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
      )}
    </>
  );
}
const statusStyle = style(
  text({ size: "xs", fontWeight: 400, color: "lowContrast" }),
  {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 6,
    padding: 0,
    minHeight: 24,
  },
);
const asleepStyle = style({ color: colors.blue[12] });
