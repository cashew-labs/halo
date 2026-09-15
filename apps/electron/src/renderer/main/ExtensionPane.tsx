/* oxlint-disable react/iframe-missing-sandbox -- ExtensionHost uses a separate origin; scripts need that origin for API and storage access. */
import { backgroundColor, flex, Padding, Text } from "maui";
import { style, useStyles } from "purse-styles";
import { useHost } from "@get-halo/web/HostProvider";
import { useExtensionsQuery, useWorkspaceQuery } from "../api/ApiProvider.tsx";
import { PaneHeader } from "./PaneHeader.js";

export function ExtensionPane({ extensionId }: { extensionId: string }) {
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
  const pane = useStyles(styles.pane);
  const frame = useStyles(styles.frame);

  return (
    <main className={pane} aria-label={displayName}>
      <PaneHeader section="Extensions" title={displayName} />
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
  pane: style(flex({ direction: "column" }), {
    width: "100%",
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
