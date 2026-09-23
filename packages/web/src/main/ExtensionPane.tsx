import { ExtensionView } from "./ExtensionView.js";

export function ExtensionPane({ extensionId }: { extensionId: string }) {
  return <ExtensionView extensionId={extensionId} />;
}
