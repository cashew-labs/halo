import { useEffect } from "react";
import { useExtensions } from "./api/WorkspaceUpdatesProvider.js";
import { ExtensionView } from "./main/ExtensionView.js";

export function StandaloneExtension({ extensionId }: { extensionId: string }) {
  const extensions = useExtensions();
  const extension = extensions.data?.find((entry) => entry.id === extensionId);
  const displayName = extension?.displayName ?? extensionId;

  useEffect(() => {
    if (extension === undefined) return;
    const query = new URLSearchParams({
      extension: extensionId,
      name: extension.displayName,
    });
    const href = `/manifest.json?${query.toString()}`;
    const manifest = document.querySelector<HTMLLinkElement>(
      'link[rel="manifest"]',
    );
    if (manifest !== null) {
      if (manifest.getAttribute("href") !== href) window.location.reload();
      return;
    }
    const link = document.createElement("link");
    link.rel = "manifest";
    link.href = href;
    // The document owns this link, even if the extension stops or signs out.
    // WebKit keeps its first manifest loader; a new identity/name needs a reload.
    document.head.append(link);
  }, [extension, extensionId]);

  return (
    <>
      <title>{extension?.displayName ?? "Halo"}</title>
      <meta name="apple-mobile-web-app-title" content={displayName} />
      <ExtensionView extensionId={extensionId} />
    </>
  );
}
