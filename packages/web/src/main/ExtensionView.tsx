/* oxlint-disable react/iframe-missing-sandbox -- Extension views need their origin identity for API and storage access. */
import { backgroundColor, Button, Flex, flex, Text, text } from "maui";
import { style, useStyles } from "purse-styles";
import { useHost } from "../HostProvider.js";
import { useExtensions } from "../api/WorkspaceUpdatesProvider.js";
import {
  PublishFailureNotice,
  useApps,
  usePublishRecovery,
} from "../panes/PublishFailure.js";

export function ExtensionView({ extensionId }: { extensionId: string }) {
  const host = useHost();
  const extensions = useExtensions();
  const extension = extensions.data?.find((entry) => entry.id === extensionId);
  // A published app runs on its creator host. Halo's tab cannot sign the
  // owner in to that origin, so the app opens in the browser instead.
  const extensionUrl =
    extension === undefined ||
    extension.remote !== undefined ||
    extension.publishing !== undefined
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
      {extension?.publishing !== undefined && (
        <PublishingNotice extensionId={extensionId} displayName={displayName} />
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

/** A project stopped while it moves to its own server, or stuck part-way. */
function PublishingNotice({
  extensionId,
  displayName,
}: {
  extensionId: string;
  displayName: string;
}) {
  const apps = useApps();
  const app = apps.data?.find((entry) => entry.extensionId === extensionId);
  const recovery = usePublishRecovery(app);
  const notice = useStyles(styles.notice);
  const actions = useStyles(styles.actions);
  const failure = app?.stage === "live" ? undefined : app?.publishFailure;
  return (
    <div className={notice}>
      {failure === undefined || recovery.publishing ? (
        <Text role="status">
          {displayName} is being published to its own server. It is paused in
          this workspace until publishing finishes.
        </Text>
      ) : (
        <>
          <PublishFailureNotice displayName={displayName} failure={failure} />
          {recovery.error !== null && (
            <Text size="sm" role="alert">
              {recovery.error.message}
            </Text>
          )}
          <div className={actions}>
            <Button
              isDisabled={recovery.pending}
              onPress={recovery.publishAgain}
            >
              Publish again
            </Button>
            <Button
              variant="quiet"
              isDisabled={recovery.pending}
              onPress={recovery.keepLocal}
            >
              Keep it local
            </Button>
          </div>
        </>
      )}
    </div>
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
  actions: style(flex({ gap: 3, wrap: true })),
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
