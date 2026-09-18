/* oxlint-disable react/iframe-missing-sandbox -- Extension views need their origin identity for API and storage access. */
import * as errore from "errore";
import { backgroundColor, Button, Flex, flex, Text, Tooltip } from "maui";
import { Link } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useHost } from "../HostProvider.js";
import { useExtensionsQuery, useWorkspaceQuery } from "../api/ApiProvider.tsx";
import { PaneHeader } from "./PaneHeader.js";

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
        <PaneHeader
          section="Extensions"
          title={displayName}
          action={
            extension === undefined ? undefined : (
              <Tooltip content="Copy link" placement="bottom" delay={400}>
                <Button
                  variant="quiet"
                  aria-label="Copy link"
                  onClick={() => void copyExtensionLink(extension.id)}
                >
                  <Link size="sm" />
                </Button>
              </Tooltip>
            )
          }
        />
      )}
      {extensions.isPending && (
        <Flex column p={8}>
          <Text role="status">Loading extension…</Text>
        </Flex>
      )}
      {extensions.isError && (
        <Flex column p={8}>
          <Text role="alert">{extensions.error.message}</Text>
        </Flex>
      )}
      {extensions.isSuccess && extension === undefined && (
        <Flex column p={8}>
          <Text>Extension '{extensionId}' is not running.</Text>
        </Flex>
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
    height: "100dvh",
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
