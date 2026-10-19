/* oxlint-disable react/iframe-missing-sandbox -- The trusted desktop viewer needs its origin for authenticated WebSockets and clipboard access. */
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { style, useStyles } from "purse-styles";
import { useCallback, useEffect, useRef, useState } from "react";
import { backgroundColor, Button, Kbd, Text, text } from "maui";
import { PaneHeaderActions } from "../panes/PaneHeader.js";
import { useHost } from "../HostProvider.js";
import { useConnection } from "../api/ConnectionContext.js";

export function DesktopPane() {
  const host = useHost();
  const { state } = useConnection();
  const iframe = useRef<HTMLIFrameElement>(null);
  const paneElement = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const src = host.getDesktopFrameUrl();
  const mode = state.power ?? "running";
  // A new pane must not load a proxy error page while the VM is still waking.
  // Once started, keep its document mounted through later pause/resume cycles.
  const [started, setStarted] = useState(
    () => state.status === "connected" && mode === "running",
  );
  if (!started && state.status === "connected" && mode === "running")
    setStarted(true);
  const sendState = useCallback(() => {
    iframe.current?.contentWindow?.postMessage(
      { type: "halo:desktop-state", mode },
      new URL(src, window.location.href).origin,
    );
  }, [src, mode]);
  useEffect(sendState, [sendState]);
  const unfocus = useCallback(() => {
    paneElement.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const desktopMessage = (event: MessageEvent) => {
      if (
        event.source !== iframe.current?.contentWindow ||
        event.origin !== new URL(src, window.location.href).origin
      )
        return;
      if (!Value.Check(desktopMessageSchema, event.data)) return;
      if (event.data.type === "halo:desktop-release-keyboard") {
        unfocus();
        return;
      }
      setFocused(event.data.focused);
    };
    window.addEventListener("message", desktopMessage);
    return () => window.removeEventListener("message", desktopMessage);
  }, [src, unfocus]);
  const pane = useStyles(desktopPane);
  const viewport = useStyles(desktopViewport);
  const frame = useStyles(desktopFrame);
  const waiting = useStyles(desktopWaiting);
  const waitingLabel = (() => {
    if (mode === "asleep") return "Asleep";
    if (mode === "waking") return "Waking…";
    if (mode === "sleeping") return "Sleeping…";
    return "Connecting to desktop…";
  })();
  return (
    <div ref={paneElement} className={pane} tabIndex={-1}>
      {focused && (
        <PaneHeaderActions>
          <Text size="sm" color="lowContrast">
            Capturing keyboard shortcuts
          </Text>
          <Button aria-label="Unfocus desktop" onPressStart={unfocus}>
            Unfocus{" "}
            <Kbd variant="quiet" aria-label="Control Escape">
              {navigator.platform.startsWith("Mac") ? "⌃Esc" : "Ctrl+Esc"}
            </Kbd>
          </Button>
        </PaneHeaderActions>
      )}
      <div className={viewport}>
        {started ? (
          <iframe
            ref={iframe}
            className={frame}
            name="halo-desktop"
            title="Desktop"
            src={src}
            onLoad={sendState}
            sandbox="allow-scripts allow-same-origin"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className={waiting} role="status" aria-live="polite">
            {waitingLabel}
          </div>
        )}
      </div>
    </div>
  );
}

const desktopMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal("halo:desktop-release-keyboard") }),
  Type.Object({
    type: Type.Literal("halo:desktop-focus"),
    focused: Type.Boolean(),
  }),
]);

const desktopPane = style({
  display: "grid",
  gridTemplateRows: "minmax(0, 1fr)",
  width: "100%",
  height: "100%",
});

const desktopViewport = style({
  minWidth: 0,
  minHeight: 0,
  backgroundColor: backgroundColor.app,
});

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
