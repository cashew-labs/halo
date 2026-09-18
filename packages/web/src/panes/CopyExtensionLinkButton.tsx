import * as errore from "errore";
import { Link } from "maui/icons";
const publicExtensionOrigin =
  "https://halo-west-control-plane-912701444316.us-west2.run.app";

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

  if (result instanceof Error) console.warn(result);
}

export function CopyExtensionLinkButton({
  extensionId,
}: {
  extensionId: string;
}) {
  return (
    <button
      type="button"
      className="paneAdd"
      aria-label="Copy link"
      title="Copy link"
      onClick={() => void copyExtensionLink(extensionId)}
    >
      <Link size="sm" />
    </button>
  );
}
