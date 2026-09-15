import { ExtensionView } from "./main/ExtensionView.js";

export function StandaloneExtension({ extensionId }: { extensionId: string }) {
  return <ExtensionView extensionId={extensionId} chrome="standalone" />;
}
