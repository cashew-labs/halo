/* oxlint-disable react/iframe-missing-sandbox -- Extension views need their origin identity for API and storage access. */
import { backgroundColor, flex, Padding, Text } from "maui";
import { style, useStyles } from "purse-styles";
import { useHost } from "../HostProvider.js";
import { useExtensionsQuery, useWorkspaceQuery } from "../api/ApiProvider.tsx";
import { PaneHeader } from "./PaneHeader.js";

export function ExtensionView({
  extensionId,
  chrome,
}: {
  extensionId: string;
  chrome: "pane" | "standalone";
}) {
  const host = useHost();
  const workspace = useWorkspaceQuery().data;
  const extensions = useExtensionsQuery(workspace);
  const extension = extensions.data?.find((entry) => entry.id === extensionId);
  const extensionUrl =
    extension === undefined
      ? undefined
      : host.getExtensionFrameUrl(extension.id);
  const displayName =
    extension === undefined ? extensionId : extension.displayName;
  const view = useStyles(styles.view);
  const frame = useStyles(styles.frame);

  return (
    <main className={view} aria-label={displayName}>
      {chrome === "pane" && (
        <PaneHeader section="Extensions" title={displayName} />
      )}
      {extensions.isPending && (
        <Padding xy={8}>
          <Text role="status">Loading extension…</Text>
        </Padding>
      )}
      {extensions.isError && (
        <Padding xy={8}>
          <Text role="alert">{extensions.error.message}</Text>
        </Padding>
      )}
      {extensions.isSuccess && extension === undefined && (
        <Padding xy={8}>
          <Text>Extension '{extensionId}' is not running.</Text>
        </Padding>
      )}
      {extension !== undefined && extensionUrl !== undefined && (
        <iframe
          key={extension.id}
          className={frame}
          title={extension.displayName}
          src={extensionUrl}
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      )}
    </main>
  );
}

const styles = {
  view: style(flex({ direction: "column" }), {
    width: "100%",
    height: "100vh",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: backgroundColor.app,
  }),
  frame: style({
    flex: "1 1 auto",
    width: "100%",
    minWidth: 0,
    minHeight: 0,
    border: 0,
  }),
};
