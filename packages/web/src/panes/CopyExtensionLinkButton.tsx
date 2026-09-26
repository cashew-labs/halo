import { useEffect, useRef, useState } from "react";
import * as errore from "errore";
import { Tooltip, motion } from "maui";
import { Check, Link } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { paneStyles } from "./paneStyles.js";

const publicExtensionOrigin = "https://gethalo.dev";

class CopyExtensionLinkError extends errore.createTaggedError({
  name: "CopyExtensionLinkError",
  message: "Could not copy the extension link.",
}) {}

async function copyExtensionLink(extensionId: string) {
  const result = await navigator.clipboard
    .writeText(
      `${publicExtensionOrigin}/extensions/${encodeURIComponent(extensionId)}`,
    )
    .catch((cause) => new CopyExtensionLinkError({ cause }));

  if (result instanceof Error) return result;
}

export function CopyExtensionLinkButton({
  extensionId,
}: {
  extensionId: string;
}) {
  const className = useStyles(paneStyles.add);
  const icon = useStyles(iconStyle);
  const copiedIcon = useStyles(visibleIconStyle);
  const hiddenIcon = useStyles(hiddenIconStyle);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  async function handleCopy() {
    const result = await copyExtensionLink(extensionId);
    if (result instanceof Error) {
      console.warn(result);
      return;
    }

    setCopied(true);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <Tooltip content={copied ? "Copied!" : "Copy link"} placement="bottom">
      <button
        type="button"
        className={className}
        data-pane-add=""
        aria-label={copied ? "Copied link" : "Copy link"}
        onClick={() => void handleCopy()}
      >
        <span className={icon} aria-hidden="true">
          <Link size="sm" className={copied ? hiddenIcon : copiedIcon} />
          <Check size="sm" className={copied ? copiedIcon : hiddenIcon} />
        </span>
      </button>
    </Tooltip>
  );
}

const iconStyle = style({
  display: "grid",
  placeItems: "center",
  "& svg": {
    gridArea: "1 / 1",
  },
});

const visibleIconStyle = style(motion.standard("opacity", "transform"), {
  opacity: 1,
  transform: "scale(1)",
  "@media (prefers-reduced-motion: reduce)": { transition: "none" },
});

const hiddenIconStyle = style(motion.standard("opacity", "transform"), {
  opacity: 0,
  transform: "scale(0.7)",
  "@media (prefers-reduced-motion: reduce)": { transition: "none" },
});
