/* oxlint-disable react/iframe-missing-sandbox -- The trusted desktop viewer needs its origin for authenticated WebSockets and clipboard access. */
import { style, useStyles } from "purse-styles";
import { useCallback, useEffect, useRef, useState } from "react";
import { backgroundColor, text } from "maui";
import { useHost } from "../HostProvider.js";
import { useConnection } from "../api/ConnectionContext.js";

export function DesktopPane() {
  const host = useHost();
  const { state } = useConnection();
  const iframe = useRef<HTMLIFrameElement>(null);
  const src = host.getDesktopFrameUrl();
  const mode = state.power ?? "running";
  // A new pane must not load a proxy error page while the VM is still waking.
  // Once started, keep its document mounted through later pause/resume cycles.
  const [started, setStarted] = useState(
    () => state.status === "connected" && mode === "running",
  );
  if (!started && state.status === "connected" && mode === "running")
    setStarted(true);
  const sendMode = useCallback(() => {
    iframe.current?.contentWindow?.postMessage(
      { type: "halo:desktop-state", mode },
      new URL(src, window.location.href).origin,
    );
  }, [src, mode]);
  useEffect(sendMode, [sendMode]);
  const frame = useStyles(desktopFrame);
  const waiting = useStyles(desktopWaiting);
  const waitingLabel = (() => {
    if (mode === "asleep") return "Asleep";
    if (mode === "waking") return "Waking…";
    if (mode === "sleeping") return "Sleeping…";
    return "Connecting to desktop…";
  })();
  if (!started)
    return (
      <div className={waiting} role="status" aria-live="polite">
        {waitingLabel}
      </div>
    );
  return (
    <iframe
      ref={iframe}
      className={frame}
      title="Desktop"
      src={src}
      onLoad={sendMode}
      sandbox="allow-scripts allow-same-origin"
      allow="clipboard-read; clipboard-write"
    />
  );
}

const desktopFrame = style({
  display: "block",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  border: 0,
});

const desktopWaiting = style(text({ size: "md", color: "lowContrast" }), {
  width: "100%",
  height: "100%",
  display: "grid",
  placeContent: "center",
  backgroundColor: backgroundColor.app,
});
