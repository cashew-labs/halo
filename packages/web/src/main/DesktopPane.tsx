/* oxlint-disable react/iframe-missing-sandbox -- The trusted desktop viewer needs its origin for authenticated WebSockets and clipboard access. */
import { style, useStyles } from "purse-styles";
import { useHost } from "../HostProvider.js";

export function DesktopPane() {
  const host = useHost();
  const frame = useStyles(desktopFrame);
  return (
    <iframe
      className={frame}
      title="Desktop"
      src={host.getDesktopFrameUrl()}
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
