import { PaneHeaderActions } from "../panes/PaneHeader.js";
import { ShareAppButton } from "../panes/ShareAppButton.js";
import { ExtensionView } from "./ExtensionView.js";

export function ExtensionPane({ extensionId }: { extensionId: string }) {
  return (
    <>
      <PaneHeaderActions>
        <ShareAppButton extensionId={extensionId} />
      </PaneHeaderActions>
      <ExtensionView extensionId={extensionId} />
    </>
  );
}
