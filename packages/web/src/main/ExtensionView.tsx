/* oxlint-disable react/iframe-missing-sandbox -- Extension views need their origin identity for API and storage access. */
import { backgroundColor, Flex, flex, Text, text } from "maui";
import { style, useStyles } from "purse-styles";
import { useHost } from "../HostProvider.js";
import { useExtensions } from "../api/WorkspaceUpdatesProvider.js";

export function ExtensionView({ extensionId }: { extensionId: string }) {
  const host = useHost();
  const extensions = useExtensions();
  const extension = extensions.data?.find((entry) => entry.id === extensionId);
  // A published app runs on its creator host. Halo's tab cannot sign the
  // owner in to that origin, so the app opens in the browser instead.
  const extensionUrl =
    extension === undefined || extension.remote !== undefined
      ? undefined
      : host.getExtensionFrameUrl(extension.id);
  const displayName =
    extension === undefined ? extensionId : extension.displayName;
  const view = useStyles(styles.view);
  const frame = useStyles(styles.frame);
  const notice = useStyles(styles.notice);
  const link = useStyles(styles.link);

  return (
    <main className={view} aria-label={displayName}>
      {extensions.data === undefined && extensions.error === undefined && (
        <Flex column p={8}>
          <Text role="status">Loading extension…</Text>
        </Flex>
      )}
      {extensions.error !== undefined && (
        <Flex column p={8}>
          <Text role="alert">{extensions.error.message}</Text>
        </Flex>
      )}
      {extensions.data !== undefined && extension === undefined && (
        <Flex column p={8}>
          <Text>Extension '{extensionId}' is not running.</Text>
        </Flex>
      )}
      {extension?.remote !== undefined && (
        <div className={notice}>
          <Text>
            {displayName} is shared from its own server. It opens in your
            browser, where you sign in to Halo once.
          </Text>
          <a
            className={link}
            href={signInUrl(extension.url)}
            target="_blank"
            rel="noreferrer"
          >
            Open {displayName}
          </a>
        </div>
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
    height: "var(--halo-window-content-height, 100dvh)",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: backgroundColor.app,
  }),
  notice: style(flex({ direction: "column", gap: 3 }), {
    padding: 32,
    maxWidth: 480,
  }),
  link: style(text({ size: "sm" }), { width: "fit-content" }),
  frame: style({
    flex: "1 1 auto",
    width: "100%",
    minWidth: 0,
    minHeight: 0,
    border: 0,
  }),
};

/** The creator host signs the owner in before opening the app, so the owner
 * is recognized even on public or unshared apps. */
function signInUrl(appUrl: string) {
  const url = new URL("/__halo/signin", appUrl);
  url.searchParams.set("return", new URL(appUrl).pathname);
  return url.toString();
}
